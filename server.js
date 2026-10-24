import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { crearExtractorRespuesta } from "./lib/streamRespuesta.js";
import { safeParseJSON } from "./lib/outfit.js";
import { fechaHoy, restarDias, calcularRacha } from "./lib/fechas.js";
import { limpiarHistorial, limpiarClima, limpiarIdsAnteriores, construirMensajeUsuario, resolverOutfit } from "./lib/fashion.js";
import { esUuid } from "./lib/validar.js";
import { rutaDesdeUrlPublica } from "./lib/storage.js";
import { colorMedible, faltaColorMedible } from "./lib/color.js";
import { colorDominante } from "./lib/colorImagen.js";
import { elegirTanda, LOTE_REANALISIS } from "./lib/tanda.js";
import { fusionarPrendasOutfit } from "./lib/prendasOutfit.js";
import { FASHION_SYSTEM_PROMPT } from "./prompts/fashion.js";

dotenv.config();

const app = express();
app.set("trust proxy", 1); // proxy de Fly.io
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));
const _corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map(o => o.trim())
  : [];
// Orígenes siempre permitidos: app nativa y despliegues conocidos
const _alwaysAllowed = [
  "https://localhost", "http://localhost", "capacitor://localhost",
  "https://beconfident.site",
  "https://closet-ia-frontend.vercel.app",
];
app.use(cors({
  origin: (origin, cb) => {
    // Sin origin (curl, Postman) → permitir
    if (!origin) return cb(null, true);
    // Orígenes siempre permitidos
    if (_alwaysAllowed.includes(origin)) return cb(null, true);
    // Sin lista configurada → permitir todo
    if (_corsOrigins.length === 0) return cb(null, true);
    // Verificar si el origin está en la lista de producción
    _corsOrigins.includes(origin) ? cb(null, true) : cb(new Error("CORS no permitido"));
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

// rate limit en endpoints con IA (OpenAI + rembg)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Demasiadas solicitudes, espera un momento." },
  standardHeaders: true,
  legacyHeaders: false,
});

const ALLOWED_MIMES = new Set(["image/jpeg","image/jpg","image/png","image/webp","image/gif","image/heic","image/heif"]);
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    ALLOWED_MIMES.has(file.mimetype)
      ? cb(null, true)
      : cb(Object.assign(new Error("Tipo de archivo no permitido"), { status: 415 }));
  },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MODEL = "gpt-4o-mini";

async function borrarImagenStorage(url) {
  const ruta = rutaDesdeUrlPublica(url);
  if (!ruta) return;
  const { error } = await supabase.storage.from("prendas").remove([ruta]);
  if (error) console.error("⚠️ borrar imagen storage:", error.message);
}

function fallar(res, etiqueta, err, status = 500) {
  console.error(`🔥 ${etiqueta}:`, err.message);
  res.status(status).json({ error: "Error interno" });
}


/* ─────────────────────────────────────
   ❤️ HEALTH CHECK — mantiene Supabase activo
───────────────────────────────────── */
app.get("/api/health", async (_req, res) => {
  const { error } = await supabase.from("profiles").select("id").limit(1);
  if (error) return res.status(500).json({ ok: false });
  res.json({ ok: true });
});

/* ─────────────────────────────────────
   🔐 AUTH MIDDLEWARE
   Verifica el JWT de Supabase y adjunta req.userId
───────────────────────────────────── */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return res.status(401).json({ error: "No autenticado" });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    console.warn("[auth] Token rechazado", { reason: error?.message || "Usuario no encontrado" });
    return res.status(401).json({
      error: "Token inválido",
      code: "AUTH_TOKEN_INVALID",
    });
  }

  req.userId = user.id;
  next();
}

/* ─────────────────────────────────────
   ⚡ CACHE DE PRENDAS EN MEMORIA
   Evita round-trips a Supabase en cada petición de fashion/swap
───────────────────────────────────── */
const _prendasCache = new Map(); // uid → { data, ts }
const PRENDAS_TTL   = 3 * 60 * 1000; // 3 minutos

const _usernameCache = new Map(); // uid → { username, ts }
const USERNAME_TTL   = 10 * 60 * 1000; // 10 minutos (usernames cambian poco)

async function getUsername(uid) {
  const cached = _usernameCache.get(uid);
  if (cached && Date.now() - cached.ts < USERNAME_TTL) return cached.username;
  const { data } = await supabase.from("profiles").select("username").eq("id", uid).single();
  const username = data?.username || "alguien";
  _usernameCache.set(uid, { username, ts: Date.now() });
  return username;
}

function getCachedPrendas(uid) {
  const e = _prendasCache.get(uid);
  if (e && Date.now() - e.ts < PRENDAS_TTL) return e.data;
  _prendasCache.delete(uid);
  return null;
}

function setCachedPrendas(uid, data) {
  if (_prendasCache.size >= 200) {
    const oldest = [..._prendasCache.entries()].reduce(
      (min, e) => (e[1].ts < min[1].ts ? e : min)
    );
    _prendasCache.delete(oldest[0]);
  }
  _prendasCache.set(uid, { data, ts: Date.now() });
}

function invalidatePrendasCache(uid) {
  _prendasCache.delete(uid);
}

/* ─────────────────────────────────────
   🧼 REMOVE BACKGROUND (servicio rembg en Hugging Face Space)
   model: "birefnet-general" para prenda individual (alta calidad)
───────────────────────────────────── */
async function removeBackground(imageBuffer, model = "birefnet-general") {
  try {
    const rembgUrl = process.env.REMBG_SERVICE_URL;
    if (!rembgUrl) {
      console.warn("⚠️ REMBG_SERVICE_URL no configurado, omitiendo remoción de fondo");
      return null;
    }

    // birefnet calcula la máscara a 1024px sin importar la entrada: achicar más solo pierde nitidez.
    // 1200px coincide con la compresión del frontend.
    const resizedBuffer = await sharp(imageBuffer)
      .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();

    const formData = new FormData();
    formData.append("file", resizedBuffer, { filename: "prenda.jpg", contentType: "image/jpeg" });
    formData.append("model", model);

    const res = await fetch(`${rembgUrl}/remove-bg`, {
      method: "POST",
      signal: AbortSignal.timeout(90000),
      headers: {
        "x-rembg-secret": process.env.REMBG_SECRET || "",
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error(`❌ rembg HF error (${model}):`, res.status, txt);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer;
  } catch (err) {
    console.error("⚠️ removeBackground excepción:", err.message);
    return null;
  }
}

/* ─────────────────────────────────────
   🔔 HELPER NOTIFICACIONES
───────────────────────────────────── */
async function crearNotificacion({ usuario_id, from_usuario_id, tipo, mensaje, post_id = null }) {
  if (usuario_id === from_usuario_id) return;
  try {
    await supabase.from("notifications").insert([{
      usuario_id, from_usuario_id, tipo, mensaje, post_id, leida: false,
    }]);
  } catch (err) {
    console.error("⚠️ Error creando notificación:", err.message);
  }
}

/* ─────────────────────────────────────
   👤 PERFIL
───────────────────────────────────── */
app.get("/api/perfil/me", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles").select("*").eq("id", req.userId).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    fallar(res, "perfil/me", err);
  }
});

app.get("/api/perfil/:username", async (req, res) => {
  try {
    const { username } = req.params;
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, nombre, bio, avatar_url, created_at")
      .eq("username", username.toLowerCase()).single();
    if (error) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json(data);
  } catch (err) {
    fallar(res, "perfil/:username", err);
  }
});

app.get("/api/usuarios/buscar", requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, nombre, avatar_url")
      .ilike("username", `%${q}%`)
      .neq("id", req.userId)
      .limit(10);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    fallar(res, "buscar usuarios", err);
  }
});

/* ─────────────────────────────────────
   ✨ SUGERIDOS — usuarios que el usuario
   actual no conoce todavía (ni amigos
   ni solicitudes pendientes).
   Usado por el sidebar del Feed.
───────────────────────────────────── */
app.get("/api/usuarios/sugeridos", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;

    // Obtener todas las conexiones existentes (aceptadas + pendientes)
    const { data: amistades } = await supabase
      .from("friendships")
      .select("requester_id, addressee_id")
      .or(`requester_id.eq.${usuario_id},addressee_id.eq.${usuario_id}`);

    // Construir set de IDs a excluir
    const excluir = new Set([usuario_id]);
    (amistades || []).forEach((f) => {
      excluir.add(f.requester_id);
      excluir.add(f.addressee_id);
    });

    // Usuarios fuera del set, ordenados por fecha de creación desc
    // para mostrar los más recientes primero
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, nombre, avatar_url, created_at")
      .not("id", "in", `(${[...excluir].join(",")})`)
      .order("created_at", { ascending: false })
      .limit(6);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    fallar(res, "sugeridos", err);
  }
});

app.put("/api/perfil", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { username, nombre, bio } = req.body;

    if (username) {
      if (!/^[a-z0-9_.]{3,30}$/.test(username.toLowerCase())) {
        return res.status(400).json({ error: "Username inválido: solo letras minúsculas, números, _ y . (3-30 caracteres)" });
      }
      const { data: existing } = await supabase
        .from("profiles").select("id")
        .eq("username", username.toLowerCase())
        .neq("id", usuario_id).single();
      if (existing) return res.status(400).json({ error: "Username ya en uso" });
    }

    const { data, error } = await supabase
      .from("profiles")
      .upsert({
        id: usuario_id,
        ...(username && { username: username.toLowerCase() }),
        ...(nombre !== undefined && { nombre }),
        ...(bio !== undefined && { bio }),
        setup_completo: true,
      }, { onConflict: "id" })
      .select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    fallar(res, "put perfil", err);
  }
});

app.post("/api/perfil/avatar", requireAuth, upload.single("avatar"), async (req, res) => {
  try {
    const usuario_id = req.userId;
    if (!req.file) return res.status(400).json({ error: "Falta imagen" });

    const buffer = await fs.promises.readFile(req.file.path);
    const fileName = `avatars/${usuario_id}_${Date.now()}.jpg`;
    const resized = await sharp(buffer).resize(400, 400, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
    const { error: uploadError } = await supabase.storage
      .from("prendas").upload(fileName, resized, { contentType: "image/jpeg", upsert: true });
    if (uploadError) throw uploadError;

    const avatarUrl = supabase.storage.from("prendas").getPublicUrl(fileName).data.publicUrl;
    await supabase.from("profiles").update({ avatar_url: avatarUrl }).eq("id", usuario_id);
    res.json({ avatar_url: avatarUrl });
  } catch (err) {
    fallar(res, "avatar", err);
  } finally {
    if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
  }
});

/* ─────────────────────────────────────
   👥 AMISTADES
───────────────────────────────────── */
app.post("/api/amistad/solicitar", requireAuth, async (req, res) => {
  try {
    const requester_id = req.userId;
    const { addressee_id } = req.body;
    if (!addressee_id) return res.status(400).json({ error: "Faltan datos" });
    if (!esUuid(addressee_id)) return res.status(400).json({ error: "ID inválido" });
    if (requester_id === addressee_id) return res.status(400).json({ error: "No puedes agregarte a ti mismo" });

    const { data: existing } = await supabase
      .from("friendships").select("id, status")
      .or(`and(requester_id.eq.${requester_id},addressee_id.eq.${addressee_id}),and(requester_id.eq.${addressee_id},addressee_id.eq.${requester_id})`)
      .single();

    if (existing) {
      if (existing.status === "accepted") return res.status(400).json({ error: "Ya son amigos" });
      if (existing.status === "pending") return res.status(400).json({ error: "Solicitud ya enviada" });
    }

    const { data, error } = await supabase
      .from("friendships")
      .insert([{ requester_id, addressee_id, status: "pending" }])
      .select().single();
    if (error) throw error;

    const username = await getUsername(requester_id);

    await crearNotificacion({
      usuario_id: addressee_id,
      from_usuario_id: requester_id,
      tipo: "solicitud",
      mensaje: `@${username} te envió una solicitud de amistad`,
    });

    res.json({ mensaje: "✅ Solicitud enviada", data });
  } catch (err) {
    fallar(res, "solicitar amistad", err);
  }
});

app.put("/api/amistad/responder", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { friendship_id, status } = req.body;
    if (!friendship_id || !status) return res.status(400).json({ error: "Faltan datos" });
    if (status !== "accepted" && status !== "rejected") return res.status(400).json({ error: "Estado inválido" });

    const { data, error } = await supabase
      .from("friendships")
      .update({ status })
      .eq("id", friendship_id)
      .eq("addressee_id", usuario_id)
      .select().single();
    if (error) throw error;

    if (status === "accepted") {
      const username = await getUsername(usuario_id);
      await crearNotificacion({
        usuario_id: data.requester_id,
        from_usuario_id: usuario_id,
        tipo: "aceptado",
        mensaje: `@${username} aceptó tu solicitud de amistad 🎉`,
      });
    }

    res.json({ mensaje: `✅ Solicitud ${status}`, data });
  } catch (err) {
    fallar(res, "responder amistad", err);
  }
});

app.get("/api/amistad/solicitudes", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { data, error } = await supabase
      .from("friendships")
      .select(`id, status, created_at, requester:requester_id(id, username, nombre, avatar_url)`)
      .eq("addressee_id", usuario_id).eq("status", "pending");
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    fallar(res, "solicitudes", err);
  }
});

app.get("/api/amistad/amigos", requireAuth, async (req, res) => {
  try {
    // uid param permite ver amigos de otro usuario (para stats de perfil)
    // Sin uid → devuelve los amigos del usuario autenticado
    if (req.query.uid !== undefined && !esUuid(req.query.uid)) return res.status(400).json({ error: "ID inválido" });
    const usuario_id = req.query.uid || req.userId;
    const { data, error } = await supabase
      .from("friendships")
      .select(`id, requester:requester_id(id, username, nombre, avatar_url), addressee:addressee_id(id, username, nombre, avatar_url)`)
      .or(`requester_id.eq.${usuario_id},addressee_id.eq.${usuario_id}`)
      .eq("status", "accepted");
    if (error) throw error;

    const amigos = (data || []).map((f) => {
      const amigo = f.requester.id === usuario_id ? f.addressee : f.requester;
      return { friendship_id: f.id, ...amigo };
    });
    res.json(amigos);
  } catch (err) {
    fallar(res, "amigos", err);
  }
});

app.get("/api/amistad/estado", requireAuth, async (req, res) => {
  try {
    const { otro_id } = req.query;
    const usuario_id = req.userId;
    if (!otro_id) return res.status(400).json({ error: "Falta otro_id" });
    if (!esUuid(otro_id)) return res.status(400).json({ error: "ID inválido" });
    const { data } = await supabase
      .from("friendships")
      .select("id, status, requester_id, addressee_id")
      .or(`and(requester_id.eq.${usuario_id},addressee_id.eq.${otro_id}),and(requester_id.eq.${otro_id},addressee_id.eq.${usuario_id})`)
      .single();
    res.json(data || { status: "none" });
  } catch {
    res.json({ status: "none" });
  }
});

app.delete("/api/amistad/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: amistad } = await supabase
      .from("friendships").select("requester_id, addressee_id").eq("id", id).single();
    if (!amistad) return res.status(404).json({ error: "Amistad no encontrada" });
    if (amistad.requester_id !== req.userId && amistad.addressee_id !== req.userId)
      return res.status(403).json({ error: "Sin permiso" });
    const { error } = await supabase.from("friendships").delete().eq("id", id);
    if (error) throw error;
    res.json({ mensaje: "🗑️ Amistad eliminada" });
  } catch (err) {
    fallar(res, "eliminar amistad", err);
  }
});

app.get("/api/prendas/amigo/:amigo_id", requireAuth, async (req, res) => {
  try {
    const { amigo_id } = req.params;
    if (!esUuid(amigo_id)) return res.status(400).json({ error: "ID inválido" });
    const usuario_id = req.userId;
    const { tipo } = req.query;

    const { data: amistad } = await supabase
      .from("friendships").select("id")
      .or(`and(requester_id.eq.${usuario_id},addressee_id.eq.${amigo_id}),and(requester_id.eq.${amigo_id},addressee_id.eq.${usuario_id})`)
      .eq("status", "accepted").single();
    if (!amistad) return res.status(403).json({ error: "No son amigos" });

    let query = supabase.from("prendas").select("*").eq("usuario_id", amigo_id).order("created_at", { ascending: false });
    if (tipo && tipo !== "todos") query = query.eq("tipo", tipo);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    fallar(res, "prendas amigo", err);
  }
});

/* ─────────────────────────────────────
   📸 SUBIR PRENDA / OUTFIT
───────────────────────────────────── */
app.post("/api/subir-prenda", requireAuth, aiLimiter, upload.single("imagen"), async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { genero = "unisex", tipo = "prenda" } = req.body;
    if (!req.file) return res.status(400).json({ error: "No se envió imagen" });

    let imagenOriginalUrl;
    let imagenOriginalBuffer = await fs.promises.readFile(req.file.path);

    imagenOriginalBuffer = await sharp(imagenOriginalBuffer).rotate().toBuffer();

    if (tipo === "prenda") {
      const sinFondo = await removeBackground(imagenOriginalBuffer, "birefnet-general");
      const bufferFinal = sinFondo || imagenOriginalBuffer;
      const tieneFondo = !sinFondo;

      const cleanName = `${usuario_id}_${Date.now()}_prenda.png`;
      const { error: uploadError } = await supabase.storage
        .from("prendas").upload(cleanName, bufferFinal, { contentType: "image/png" });
      if (uploadError) throw uploadError;

      imagenOriginalUrl = supabase.storage.from("prendas").getPublicUrl(cleanName).data.publicUrl;

      const ai = await openai.chat.completions.create({
        model: MODEL,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: `Eres un experto en moda y retail con visión detallada.
Analiza la imagen. Considera prenda válida cualquier ropa, calzado o accesorio de moda, tanto si aparece sola como si la lleva puesta una persona.
Solo devuelve {"tipo":"no_prenda"} si la imagen claramente NO tiene ninguna prenda: por ejemplo una foto de comida, paisaje, animal o texto.
En caso de duda, analiza la prenda más visible.

Devuelve SOLO este JSON (sin texto extra):
{
  "nombre": "tenis",
  "color": "café/marrón",
  "tipo": "calzado",
  "material": "cuero sintético",
  "temporada": "todo el año",
  "estilo": "casual",
  "patron": "liso",
  "fit": "regular",
  "color_hex": "#8B5A2B"
}
Reglas para cada campo:
- color_hex: hex #RRGGBB del color principal de la prenda.
- color: muy específico (café, marrón, beige, crema, burdeos, mostaza, camel, terracota, verde oliva, azul marino). Principal si hay varios: "negro con blanco".
- nombre: término correcto (tenis, botines, mocasines, chaqueta, sudadera, hoodie, polo, blusa, etc).
- tipo: SOLO uno de: calzado, parte superior, parte inferior, accesorio, abrigo, vestido.
  vestido = vestidos, monos completos, jumpsuits, enterizos (prendas que cubren torso y piernas en una sola pieza).
  abrigo = chaquetas, sudaderas, hoodies, blazers, sacos, abrigos.
  accesorio = gorras, bolsos, bandoleras, relojes, manillas, collares, cinturones, lentes, bufandas.
- material: algodón, poliéster, lino, denim, cuero, lana, seda, sintético, punto, etc.
- temporada: verano, invierno, primavera/otoño, todo el año.
- estilo: casual, formal, deportivo, elegante, streetwear, bohemio, minimalista, etc.
- patron: liso, rayas, cuadros, floral, estampado, camuflaje, tie-dye, animal print, etc.
- fit: slim, regular, oversized, ajustado, holgado, etc.`,
            },
            { type: "image_url", image_url: { url: imagenOriginalUrl, detail: "low" } },
          ],
        }],
        temperature: 0,
        max_tokens: 300,
      });

      const parsed = safeParseJSON(ai?.choices?.[0]?.message?.content);

      // Si la IA detecta que no es una prenda, eliminar de storage y rechazar
      if (parsed?.tipo === "no_prenda") {
        await supabase.storage.from("prendas").remove([cleanName]);
        return res.status(422).json({ error: "La imagen no parece contener una prenda de ropa, calzado o accesorio." });
      }

      const hexDominante = sinFondo ? await colorDominante(sinFondo).catch(() => null) : null;
      const colorMed = colorMedible(hexDominante || parsed?.color_hex);
      const metadataPrenda = { ...(parsed || {}) };
      delete metadataPrenda.color_hex;
      if (colorMed) metadataPrenda.color_medible = colorMed;

      const nombre = parsed?.nombre || "prenda";
      const color = parsed?.color || "?";
      const tipoPrenda = parsed?.tipo || "?";
      const descripcion = `${nombre} (${color}) - ${tipoPrenda}`;

      await supabase.from("prendas").insert([{
        usuario_id, tipo: "prenda", genero,
        imagen_url: imagenOriginalUrl,
        descripcion, metadata_ia: metadataPrenda,
      }]);
      invalidatePrendasCache(usuario_id);

      return res.json({
        mensaje: tieneFondo
          ? "✅ Prenda guardada (fondo no removido)"
          : "✅ Prenda guardada sin fondo",
      });
    }

    if (tipo === "outfit") {
      const outfitName = `${usuario_id}_${Date.now()}_outfit.jpg`;
      const outfitJpeg = await sharp(imagenOriginalBuffer).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
      const { error: uploadError } = await supabase.storage
        .from("prendas").upload(outfitName, outfitJpeg, { contentType: "image/jpeg" });
      if (uploadError) throw uploadError;

      imagenOriginalUrl = supabase.storage.from("prendas").getPublicUrl(outfitName).data.publicUrl;

      const ai = await openai.chat.completions.create({
        model: MODEL,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: `Eres un experto en moda y retail con visión detallada.
Analiza este outfit y devuelve SOLO este JSON:
{
  "prendas": [
    { "nombre": "camiseta", "color": "blanco", "tipo": "parte superior", "color_hex": "#F5F5F5" },
    { "nombre": "pantalón cargo", "color": "verde oliva", "tipo": "parte inferior", "color_hex": "#6B6B3A" }
  ],
  "descripcion_outfit": "Outfit casual con camiseta blanca y pantalón cargo verde oliva"
}
Reglas: colores específicos, nombres correctos, tipos: calzado/parte superior/parte inferior/accesorio/abrigo. Incluye TODAS las prendas visibles. color_hex: hex #RRGGBB del color de cada prenda.`,
            },
            { type: "image_url", image_url: { url: imagenOriginalUrl, detail: "low" } },
          ],
        }],
        temperature: 0,
        max_tokens: 800,
      });

      const parsed = safeParseJSON(ai?.choices?.[0]?.message?.content);
      const prendasDetectadas = (Array.isArray(parsed?.prendas) ? parsed.prendas : []).map(({ color_hex, ...p }) => {
        const cm = colorMedible(color_hex);
        return cm ? { ...p, color_medible: cm } : p;
      });
      const descripcionOutfit = parsed?.descripcion_outfit || "Outfit completo";

      await supabase.from("prendas").insert([{
        usuario_id, tipo: "outfit", genero,
        imagen_url: imagenOriginalUrl,
        descripcion: descripcionOutfit,
        metadata_ia: { prendas: prendasDetectadas },
      }]);
      invalidatePrendasCache(usuario_id);

      return res.json({
        mensaje: `✅ Outfit guardado con ${prendasDetectadas.length} prenda(s) detectadas`,
      });
    }

    res.status(400).json({ error: "Tipo inválido, usa 'prenda' o 'outfit'" });
  } catch (err) {
    fallar(res, "subir-prenda", err);
  } finally {
    if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
  }
});

/* ─────────────────────────────────────
   📋 OBTENER PRENDAS
───────────────────────────────────── */
app.get("/api/prendas", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { tipo } = req.query;

    // Cache solo cuando se piden todas (sin filtro de tipo)
    if (!tipo || tipo === "todos") {
      const cached = getCachedPrendas(usuario_id);
      if (cached) return res.json(cached);
    }

    let query = supabase.from("prendas").select("*").eq("usuario_id", usuario_id).order("created_at", { ascending: false });
    if (tipo && tipo !== "todos") query = query.eq("tipo", tipo);
    const { data, error } = await query;
    if (error) throw error;

    if (!tipo || tipo === "todos") setCachedPrendas(usuario_id, data || []);
    res.json(data || []);
  } catch (err) {
    fallar(res, "get prendas", err);
  }
});

/* ─────────────────────────────────────
   ❌ ELIMINAR PRENDA
───────────────────────────────────── */
app.delete("/api/prendas/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: prenda } = await supabase.from("prendas").select("usuario_id, imagen_url").eq("id", id).single();
    if (!prenda) return res.status(404).json({ error: "Prenda no encontrada" });
    if (prenda.usuario_id !== req.userId) return res.status(403).json({ error: "Sin permiso" });
    const { error } = await supabase.from("prendas").delete().eq("id", id);
    if (error) throw error;
    // El calendario copia la URL de la prenda: no borrar si aún se usa allí.
    const [rA, rB] = await Promise.all([
      supabase.from("calendar_outfits").select("id", { count: "exact", head: true })
        .eq("usuario_id", req.userId).eq("imagen_url", prenda.imagen_url),
      supabase.from("calendar_outfits").select("id", { count: "exact", head: true })
        .eq("usuario_id", req.userId)
        .contains("metadata", { outfit: [{ imagen_url: prenda.imagen_url }] }),
    ]);
    const enUso = rA.error || rB.error || rA.count > 0 || rB.count > 0;
    if (!enUso) await borrarImagenStorage(prenda.imagen_url);
    invalidatePrendasCache(req.userId);
    res.json({ mensaje: "🗑️ Eliminado" });
  } catch (err) {
    fallar(res, "delete", err);
  }
});

/* Descarga una imagen de nuestro Storage (timeout 15 s). Devuelve Buffer o null. */
async function descargarImagen(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function contarPendientesColor(usuario_id) {
  const { data, error } = await supabase
    .from("prendas").select("id, tipo, metadata_ia").eq("usuario_id", usuario_id).limit(500);
  if (error) throw error;
  return (data || []).filter(faltaColorMedible).length;
}

app.get("/api/prendas/pendientes-color", requireAuth, async (req, res) => {
  try {
    res.json({ pendientes: await contarPendientesColor(req.userId) });
  } catch (err) {
    fallar(res, "pendientes-color", err);
  }
});

/* ─────────────────────────────────────
   🔄 RE-ANÁLISIS DE PRENDAS EXISTENTES
   Enriquece metadata_ia (material, temporada, estilo, patrón, fit) y
   guarda el color medible de prendas y outfits.
───────────────────────────────────── */
app.post("/api/prendas/reanalizar", requireAuth, aiLimiter, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { data: items, error } = await supabase
      .from("prendas")
      .select("id, tipo, imagen_url, descripcion, metadata_ia")
      .eq("usuario_id", usuario_id)
      .in("tipo", ["prenda", "outfit"])
      .limit(500);

    if (error) throw error;
    if (!items || items.length === 0)
      return res.json({ mensaje: "No hay prendas para analizar.", actualizadas: 0, total: 0, pendientes: 0 });

    const faltaEnriquecer = (p) => {
      const m = p.metadata_ia || {};
      return p.tipo === "prenda" && (!m.material || !m.temporada || !m.estilo || !m.patron || !m.fit);
    };
    const candidatas = items.filter(p => faltaEnriquecer(p) || faltaColorMedible(p));
    const pendientes = elegirTanda(candidatas, faltaColorMedible, LOTE_REANALISIS);

    if (pendientes.length === 0)
      return res.json({ mensaje: "Todas las prendas ya tienen metadata completa.", actualizadas: 0, total: 0, pendientes: 0 });

    let actualizadas = 0;
    const LOTE = 5; // de a 5 para no saturar la API

    const reanalizarOutfit = async (outfit) => {
      const ai = await openai.chat.completions.create({
        model: MODEL,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: `Analiza este outfit y devuelve SOLO este JSON:
{
  "prendas": [
    { "nombre": "camiseta", "color": "blanco", "tipo": "parte superior", "color_hex": "#F5F5F5" }
  ]
}
Reglas: colores específicos, nombres correctos, tipos: calzado/parte superior/parte inferior/accesorio/abrigo. Incluye TODAS las prendas visibles. color_hex: hex #RRGGBB del color de cada prenda.`,
            },
            { type: "image_url", image_url: { url: outfit.imagen_url, detail: "low" } },
          ],
        }],
        temperature: 0,
        max_tokens: 800,
      });
      const parsed = safeParseJSON(ai?.choices?.[0]?.message?.content);
      const lista = fusionarPrendasOutfit(outfit.metadata_ia?.prendas, parsed?.prendas);
      if (!lista) return;
      await supabase.from("prendas").update({
        metadata_ia: { ...(outfit.metadata_ia || {}), prendas: lista },
      }).eq("id", outfit.id);
      actualizadas++;
    };

    const reanalizarPrenda = async (prenda) => {
      const needEnriquecer = faltaEnriquecer(prenda);
      const needColor = faltaColorMedible(prenda);

      let hex = null;
      if (needColor && prenda.imagen_url) {
        const buf = await descargarImagen(prenda.imagen_url);
        if (buf) hex = await colorDominante(buf).catch(() => null);
      }

      let parsed = null;
      if (needEnriquecer || (needColor && !hex)) {
        const ai = await openai.chat.completions.create({
          model: MODEL,
          messages: [{
            role: "user",
            content: [
              {
                type: "text",
                text: `Analiza esta prenda y devuelve SOLO este JSON:
{
  "nombre": "...",
  "color": "...",
  "tipo": "...",
  "material": "...",
  "temporada": "...",
  "estilo": "...",
  "patron": "...",
  "fit": "...",
  "color_hex": "#RRGGBB"
}
tipo: calzado | parte superior | parte inferior | accesorio | abrigo | vestido
  abrigo = chaquetas/sudaderas/hoodies/blazers
  vestido = vestidos/monos/jumpsuits/enterizos
  accesorio = gorras/bolsos/relojes/manillas/collares/cinturones/lentes
material: algodón, denim, cuero, lana, lino, poliéster, punto, sintético, seda...
temporada: verano | invierno | primavera/otoño | todo el año
estilo: casual | formal | deportivo | streetwear | elegante | bohemio | minimalista
patron: liso | rayas | cuadros | floral | estampado | camuflaje | animal print
fit: slim | regular | oversized | ajustado | holgado
color_hex: hex #RRGGBB del color principal de la prenda`,
              },
              { type: "image_url", image_url: { url: prenda.imagen_url, detail: "low" } },
            ],
          }],
          temperature: 0,
          max_tokens: 300,
        });
        parsed = safeParseJSON(ai?.choices?.[0]?.message?.content);
        if (!parsed) return;
      }

      const metaActual = prenda.metadata_ia || {};
      const metaNueva = { ...metaActual };
      let descripcion;
      if (parsed) {
        Object.assign(metaNueva, {
          nombre:    parsed.nombre    || metaActual.nombre    || "",
          color:     parsed.color     || metaActual.color     || "",
          tipo:      parsed.tipo      || metaActual.tipo      || "",
          material:  parsed.material  || metaActual.material  || "",
          temporada: parsed.temporada || metaActual.temporada || "",
          estilo:    parsed.estilo    || metaActual.estilo    || "",
          patron:    parsed.patron    || metaActual.patron    || "",
          fit:       parsed.fit       || metaActual.fit       || "",
        });
        delete metaNueva.color_hex;
        const nombre = metaNueva.nombre || prenda.descripcion.split(" (")[0];
        const color  = metaNueva.color  || prenda.descripcion.match(/\(([^)]+)\)/)?.[1] || "?";
        const tipo   = metaNueva.tipo   || prenda.descripcion.split(" - ").pop() || "?";
        descripcion = `${nombre} (${color}) - ${tipo}`;
      }

      if (needColor) {
        const cm = colorMedible(hex || parsed?.color_hex);
        if (cm) metaNueva.color_medible = cm;
      }

      const cambios = { metadata_ia: metaNueva };
      if (descripcion) cambios.descripcion = descripcion;
      await supabase.from("prendas").update(cambios).eq("id", prenda.id);
      actualizadas++;
    };

    for (let i = 0; i < pendientes.length; i += LOTE) {
      const lote = pendientes.slice(i, i + LOTE);
      await Promise.allSettled(lote.map(async (item) => {
        try {
          if (item.tipo === "outfit") await reanalizarOutfit(item);
          else await reanalizarPrenda(item);
        } catch (e) {
          console.error(`🔥 reanalizar ${item.tipo} ${item.id}:`, e.message);
        }
      }));
    }

    invalidatePrendasCache(usuario_id);
    const restantes = await contarPendientesColor(usuario_id);
    res.json({ mensaje: `✅ ${actualizadas} de ${pendientes.length} prendas actualizadas.`, actualizadas, total: pendientes.length, pendientes: restantes });
  } catch (err) {
    fallar(res, "reanalizar", err);
  }
});

/* ─────────────────────────────────────
   👗 FASHION IA
───────────────────────────────────── */

async function registrarRachaHoy(usuario_id) {
  try {
    await supabase.from("calendario").insert({ usuario_id, fecha: fechaHoy() });
  } catch { /* duplicado o error — la racha deduplica por Set */ }
}

/* Validación común de los dos endpoints. Devuelve { error } o los datos limpios. */
function validarPeticionFashion(body) {
  const { mensaje, historial, outfit_ids_anteriores = [], clima } = body || {};
  if (typeof mensaje !== "string" || !mensaje.trim() || mensaje.length > 1000)
    return { error: "Mensaje inválido" };
  if (!Array.isArray(outfit_ids_anteriores)) return { error: "Formato inválido" };
  return { mensaje, historial: limpiarHistorial(historial), outfitIdsAnteriores: limpiarIdsAnteriores(outfit_ids_anteriores), clima: limpiarClima(clima) };
}

/* Prendas (con caché) + perfil + outfits recientes de calendar_outfits, en paralelo */
async function cargarDatosFashion(usuario_id) {
  let prendas = getCachedPrendas(usuario_id);
  const [prendasResult, perfilResult, calendarioResult] = await Promise.allSettled([
    prendas
      ? Promise.resolve({ data: prendas })
      : supabase.from("prendas").select("*").eq("usuario_id", usuario_id).order("created_at", { ascending: false }),
    supabase.from("profiles").select("nombre, bio, genero").eq("id", usuario_id).single(),
    supabase.from("calendar_outfits")
      .select("fecha, descripcion, metadata")
      .eq("usuario_id", usuario_id)
      .gte("fecha", restarDias(fechaHoy(), 14))
      .lte("fecha", fechaHoy())
      .order("fecha", { ascending: false })
      .limit(10),
  ]);

  if (!prendas) {
    prendas = prendasResult.status === "fulfilled" ? (prendasResult.value.data || []) : [];
    if (prendas.length) setCachedPrendas(usuario_id, prendas);
  }
  const perfil = perfilResult.status === "fulfilled" ? perfilResult.value.data : null;
  const calendarioReciente = calendarioResult.status === "fulfilled" ? (calendarioResult.value.data || []) : [];
  return { prendas, perfil, calendarioReciente };
}

/* Mensajes para OpenAI, idénticos en ambos endpoints */
function mensajesFashion({ datos, prendasSueltas, outfitsGuardados, peticion }) {
  return [
    { role: "system", content: FASHION_SYSTEM_PROMPT },
    {
      role: "user",
      content: construirMensajeUsuario({
        perfil: datos.perfil,
        clima: peticion.clima,
        prendasSueltas,
        outfitsGuardados,
        outfitIdsAnteriores: peticion.outfitIdsAnteriores,
        calendarioReciente: datos.calendarioReciente,
        historial: peticion.historial,
        mensaje: peticion.mensaje,
      }),
    },
  ];
}

function iniciarSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

/* ─────────────────────────────────────
   🌊 FASHION STREAMING — SSE typewriter
───────────────────────────────────────── */
app.post("/api/fashion/stream", requireAuth, aiLimiter, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const peticion = validarPeticionFashion(req.body);
    if (peticion.error) return res.status(400).json({ error: peticion.error });

    const datos = await cargarDatosFashion(usuario_id);

    if (!datos.prendas || datos.prendas.length === 0) {
      iniciarSSE(res);
      res.write(`data: ${JSON.stringify({ type: "text", chunk: "No tienes prendas registradas aún. ¡Sube algunas fotos de tu closet para que pueda ayudarte!" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done", outfit: [], outfit_guardado: null, cambiar_panel: false, sugerencias: [] })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    const prendasSueltas = datos.prendas.filter((p) => p.tipo === "prenda");
    const outfitsGuardados = datos.prendas.filter((p) => p.tipo === "outfit");

    iniciarSSE(res);

    /* ── Cancelar si el cliente desconecta ── */
    let clientGone = false;
    res.on("close", () => { if (!res.writableEnded) clientGone = true; });

    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages: mensajesFashion({ datos, prendasSueltas, outfitsGuardados, peticion }),
      max_tokens: 900,
      temperature: 0.7,
      stream: true,
    });

    /* ── Extrae "respuesta" mientras acumula el JSON completo ── */
    const extractor = crearExtractorRespuesta();
    let fullAccumulated = "";

    for await (const chunk of stream) {
      if (clientGone) break;
      const rawPiece = chunk.choices[0]?.delta?.content ?? "";
      if (!rawPiece) continue;
      fullAccumulated += rawPiece;

      const text = extractor.push(rawPiece);
      if (text && !clientGone) {
        res.write(`data: ${JSON.stringify({ type: "text", chunk: text })}\n\n`);
      }
    }

    if (clientGone) return res.end();

    const resultado = resolverOutfit(safeParseJSON(fullAccumulated), prendasSueltas, outfitsGuardados);
    if (resultado.cambiar_panel) registrarRachaHoy(usuario_id);
    res.write(`data: ${JSON.stringify({ type: "done", ...resultado })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("🔥 fashion/stream:", err.message);
    if (!res.headersSent) return res.status(500).json({ error: "Error interno" });
    res.write(`data: ${JSON.stringify({ type: "error", message: "Error al generar el outfit." })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

app.post("/api/fashion", requireAuth, aiLimiter, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const peticion = validarPeticionFashion(req.body);
    if (peticion.error) return res.status(400).json({ error: peticion.error });

    const datos = await cargarDatosFashion(usuario_id);

    if (!datos.prendas || datos.prendas.length === 0) {
      return res.json({
        respuesta: "No tienes prendas registradas aún. ¡Sube algunas fotos de tu closet para que pueda ayudarte!",
        outfit: [], outfit_guardado: null, cambiar_panel: false,
      });
    }

    const prendasSueltas = datos.prendas.filter((p) => p.tipo === "prenda");
    const outfitsGuardados = datos.prendas.filter((p) => p.tipo === "outfit");

    const ai = await openai.chat.completions.create({
      model: MODEL,
      messages: mensajesFashion({ datos, prendasSueltas, outfitsGuardados, peticion }),
      max_tokens: 900,
      temperature: 0.7,
    });

    const parsed = safeParseJSON(ai?.choices?.[0]?.message?.content);
    const resultado = resolverOutfit(parsed, prendasSueltas, outfitsGuardados);
    if (resultado.cambiar_panel) registrarRachaHoy(usuario_id);

    const respuesta = !parsed
      ? "Te armé una combinación con lo que tienes disponible. ¡Pruébala y dime qué piensas!"
      : parsed.respuesta || "Aquí tienes un outfit que combina muy bien.";
    res.json({ respuesta, ...resultado });
  } catch (err) {
    console.error("🔥 fashion:", err.message);
    res.status(500).json({
      respuesta: "Ocurrió un error al generar el outfit. Inténtalo de nuevo.",
      outfit: [], outfit_guardado: null, cambiar_panel: false,
    });
  }
});

/* ─────────────────────────────────────
   📊 ESTADÍSTICAS — recomendaciones de compra con IA
───────────────────────────────────────── */
app.post("/api/recomendaciones-compra", requireAuth, aiLimiter, async (req, res) => {
  try {
    const usuario_id = req.userId;

    let prendas = getCachedPrendas(usuario_id);
    if (!prendas) {
      const { data, error } = await supabase
        .from("prendas").select("*").eq("usuario_id", usuario_id).eq("tipo", "prenda");
      if (error) throw error;
      prendas = data || [];
    }
    const sueltas = prendas.filter(p => p.tipo === "prenda");
    if (sueltas.length === 0) {
      return res.json({ recomendaciones: ["Sube tus primeras prendas para recibir sugerencias"] });
    }

    const lista = sueltas.map(p => p.descripcion).join("\n");
    const ai = await openai.chat.completions.create({
      model: MODEL,
      messages: [{
        role: "user",
        content: `Analiza este closet y dame exactamente 3 recomendaciones MUY cortas (máx 10 palabras cada una) de prendas que debería comprar para completarlo o mejorar sus combinaciones. Solo el nombre de la prenda/sugerencia, sin explicación larga.\n\nCloset:\n${lista}\n\nDevuelve SOLO este JSON: {"recomendaciones":["...","...","..."]}`,
      }],
      temperature: 0.7,
      max_tokens: 150,
    });
    const parsed = safeParseJSON(ai?.choices?.[0]?.message?.content);
    res.json({ recomendaciones: parsed?.recomendaciones || [] });
  } catch (err) {
    console.error("📊 recomendaciones:", err.message);
    res.status(500).json({ recomendaciones: [] });
  }
});

/* ─────────────────────────────────────
   🔢 HELPER — enrich posts (evita N+1 queries)
   3 queries totales sin importar cuántos posts haya
───────────────────────────────────── */
async function enrichPosts(posts, postIds, viewerUserId) {
  const [
    { data: allLikes },
    { data: allComments },
    { data: myLikes },
  ] = await Promise.all([
    supabase.from("likes").select("post_id").in("post_id", postIds),
    supabase.from("comments").select("post_id").in("post_id", postIds),
    viewerUserId
      ? supabase.from("likes").select("post_id").in("post_id", postIds).eq("usuario_id", viewerUserId)
      : Promise.resolve({ data: [] }),
  ]);

  const likesMap = {};
  const commentsMap = {};
  const myLikesSet = new Set((myLikes || []).map((l) => l.post_id));

  for (const l of allLikes || []) likesMap[l.post_id] = (likesMap[l.post_id] || 0) + 1;
  for (const c of allComments || []) commentsMap[c.post_id] = (commentsMap[c.post_id] || 0) + 1;

  return posts.map((post) => ({
    ...post,
    likes_count: likesMap[post.id] || 0,
    comments_count: commentsMap[post.id] || 0,
    liked_by_me: myLikesSet.has(post.id),
  }));
}

/* ─────────────────────────────────────
   📸 POSTS — FEED
───────────────────────────────────── */
app.post("/api/posts", requireAuth, upload.single("imagen"), async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { descripcion, prendas } = req.body;
    if (!req.file) return res.status(400).json({ error: "Falta imagen" });

    const buffer = await fs.promises.readFile(req.file.path);
    const rotated = await sharp(buffer)
      .rotate()
      .resize(1080, 1080, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const fileName = `posts/${usuario_id}_${Date.now()}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from("prendas").upload(fileName, rotated, { contentType: "image/jpeg" });
    if (uploadError) throw uploadError;

    const imagen_url = supabase.storage.from("prendas").getPublicUrl(fileName).data.publicUrl;

    // JSON.parse seguro
    let prendasParsed = [];
    if (prendas) {
      try { prendasParsed = JSON.parse(prendas); } catch { prendasParsed = []; }
    }

    const { data, error } = await supabase
      .from("posts")
      .insert([{ usuario_id, imagen_url, descripcion: descripcion || "", prendas: prendasParsed }])
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    fallar(res, "crear post", err);
  } finally {
    if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
  }
});

app.get("/api/feed", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { before, limit: rawLimit } = req.query;
    const PAGE_SIZE = Math.min(parseInt(rawLimit) || 20, 50);

    const { data: amistades } = await supabase
      .from("friendships")
      .select("requester_id, addressee_id")
      .or(`requester_id.eq.${usuario_id},addressee_id.eq.${usuario_id}`)
      .eq("status", "accepted");

    const amigoIds = (amistades || []).map((f) =>
      f.requester_id === usuario_id ? f.addressee_id : f.requester_id
    );
    const todosIds = [usuario_id, ...amigoIds];

    let query = supabase
      .from("posts")
      .select(`id, imagen_url, descripcion, prendas, created_at, usuario_id, profile:usuario_id(id, username, nombre, avatar_url)`)
      .in("usuario_id", todosIds)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE + 1);

    if (before) query = query.lt("created_at", before);

    const { data: posts, error } = await query;
    if (error) throw error;

    const hasMore = (posts || []).length > PAGE_SIZE;
    const page = hasMore ? posts.slice(0, PAGE_SIZE) : (posts || []);
    const nextCursor = hasMore ? page[page.length - 1].created_at : null;

    const postIds = page.map((p) => p.id);
    const postsConData = postIds.length === 0 ? [] : await enrichPosts(page, postIds, usuario_id);

    res.json({ posts: postsConData, nextCursor });
  } catch (err) {
    fallar(res, "feed", err);
  }
});

app.get("/api/posts/:usuario_id", async (req, res) => {
  try {
    const { usuario_id } = req.params;
    const { viewer_id } = req.query;
    const { data, error } = await supabase
      .from("posts").select("id, imagen_url, descripcion, prendas, created_at")
      .eq("usuario_id", usuario_id).order("created_at", { ascending: false });
    if (error) throw error;

    const postIds = (data || []).map((p) => p.id);
    const postsConData = postIds.length === 0 ? [] : await enrichPosts(data, postIds, viewer_id || null);
    res.json(postsConData);
  } catch (err) {
    fallar(res, "posts usuario", err);
  }
});

app.delete("/api/posts/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: post } = await supabase.from("posts").select("usuario_id, imagen_url").eq("id", id).single();
    if (!post) return res.status(404).json({ error: "Post no encontrado" });
    if (post.usuario_id !== req.userId) return res.status(403).json({ error: "Sin permiso" });
    const { error } = await supabase.from("posts").delete().eq("id", id);
    if (error) throw error;
    await borrarImagenStorage(post.imagen_url);
    res.json({ mensaje: "🗑️ Post eliminado" });
  } catch (err) {
    fallar(res, "delete post", err);
  }
});

/* ─────────────────────────────────────
   ❤️ LIKES (con notificación)
───────────────────────────────────── */
app.post("/api/likes", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { post_id } = req.body;
    if (!post_id) return res.status(400).json({ error: "Faltan datos" });

    const { data: existing } = await supabase
      .from("likes").select("id").eq("post_id", post_id).eq("usuario_id", usuario_id).single();

    if (existing) {
      await supabase.from("likes").delete().eq("id", existing.id);
      return res.json({ liked: false });
    }

    await supabase.from("likes").insert([{ post_id, usuario_id }]);

    const [{ data: post }, username] = await Promise.all([
      supabase.from("posts").select("usuario_id").eq("id", post_id).single(),
      getUsername(usuario_id),
    ]);

    if (post?.usuario_id) {
      await crearNotificacion({
        usuario_id: post.usuario_id,
        from_usuario_id: usuario_id,
        tipo: "like",
        mensaje: `@${username} le dio ❤️ a tu outfit`,
        post_id,
      });
    }

    res.json({ liked: true });
  } catch (err) {
    fallar(res, "like", err);
  }
});

/* ─────────────────────────────────────
   💬 COMENTARIOS (con notificación)
───────────────────────────────────── */
app.get("/api/comments/:post_id", async (req, res) => {
  try {
    const { post_id } = req.params;
    const { data, error } = await supabase
      .from("comments")
      .select(`id, texto, created_at, usuario_id, profile:usuario_id(id, username, nombre, avatar_url)`)
      .eq("post_id", post_id).order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    fallar(res, "get comments", err);
  }
});

app.post("/api/comments", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { post_id, texto } = req.body;
    if (!post_id || !texto?.trim()) return res.status(400).json({ error: "Faltan datos" });

    const { data, error } = await supabase
      .from("comments")
      .insert([{ post_id, usuario_id, texto: texto.trim() }])
      .select(`id, texto, created_at, usuario_id, profile:usuario_id(id, username, nombre, avatar_url)`)
      .single();
    if (error) throw error;

    const { data: post } = await supabase.from("posts").select("usuario_id").eq("id", post_id).single();
    if (post?.usuario_id) {
      await crearNotificacion({
        usuario_id: post.usuario_id,
        from_usuario_id: usuario_id,
        tipo: "comentario",
        mensaje: `@${data.profile?.username || "alguien"} comentó: "${texto.trim().slice(0, 40)}${texto.length > 40 ? "..." : ""}"`,
        post_id,
      });
    }

    res.json(data);
  } catch (err) {
    fallar(res, "comentar", err);
  }
});

app.delete("/api/comments/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: comment } = await supabase.from("comments").select("usuario_id").eq("id", id).single();
    if (!comment) return res.status(404).json({ error: "Comentario no encontrado" });
    if (comment.usuario_id !== req.userId) return res.status(403).json({ error: "Sin permiso" });
    const { error } = await supabase.from("comments").delete().eq("id", id);
    if (error) throw error;
    res.json({ mensaje: "🗑️ Comentario eliminado" });
  } catch (err) {
    fallar(res, "delete comment", err);
  }
});

/* ─────────────────────────────────────
   🌟 WISHLIST
───────────────────────────────────── */
app.get("/api/wishlist", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { data, error } = await supabase
      .from("wishlist")
      .select(`id, imagen_url, descripcion, created_at, post_id,
        post:post_id(id, imagen_url, descripcion, profile:usuario_id(username, nombre, avatar_url))`)
      .eq("usuario_id", usuario_id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    fallar(res, "wishlist", err);
  }
});

app.post("/api/wishlist", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { post_id, imagen_url, descripcion } = req.body;
    if (!post_id) return res.status(400).json({ error: "Faltan datos" });

    const { data: existing } = await supabase
      .from("wishlist").select("id").eq("usuario_id", usuario_id).eq("post_id", post_id).single();

    if (existing) {
      await supabase.from("wishlist").delete().eq("id", existing.id);
      return res.json({ saved: false });
    }

    await supabase.from("wishlist").insert([{ usuario_id, post_id, imagen_url, descripcion }]);
    res.json({ saved: true });
  } catch (err) {
    fallar(res, "wishlist toggle", err);
  }
});

app.delete("/api/wishlist/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: item } = await supabase.from("wishlist").select("usuario_id").eq("id", id).single();
    if (!item) return res.status(404).json({ error: "No encontrado" });
    if (item.usuario_id !== req.userId) return res.status(403).json({ error: "Sin permiso" });
    const { error } = await supabase.from("wishlist").delete().eq("id", id);
    if (error) throw error;
    res.json({ mensaje: "🗑️ Eliminado de wishlist" });
  } catch (err) {
    fallar(res, "delete wishlist", err);
  }
});

/* ─────────────────────────────────────
   🔔 NOTIFICACIONES
───────────────────────────────────── */
app.get("/api/notificaciones/count", requireAuth, async (req, res) => {
  try {
    const { count, error } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("usuario_id", req.userId)
      .eq("leida", false);

    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (err) {
    fallar(res, "notif count", err);
  }
});

app.get("/api/notificaciones", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("notifications")
      .select(`
        id, tipo, mensaje, leida, created_at, post_id,
        from_profile:from_usuario_id(id, username, nombre, avatar_url)
      `)
      .eq("usuario_id", req.userId)
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    fallar(res, "notificaciones", err);
  }
});

app.put("/api/notificaciones/leer", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("notifications")
      .update({ leida: true })
      .eq("usuario_id", req.userId)
      .eq("leida", false);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    fallar(res, "marcar leidas", err);
  }
});

app.delete("/api/notificaciones/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: notif } = await supabase.from("notifications").select("usuario_id").eq("id", id).single();
    if (!notif) return res.status(404).json({ error: "No encontrada" });
    if (notif.usuario_id !== req.userId) return res.status(403).json({ error: "Sin permiso" });
    const { error } = await supabase.from("notifications").delete().eq("id", id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    fallar(res, "delete notif", err);
  }
});

app.delete("/api/notificaciones", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("usuario_id", req.userId);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    fallar(res, "delete todas notif", err);
  }
});

/* ─────────────────────────────────────
   📅 CALENDARIO
───────────────────────────────────── */
app.get("/api/calendario", requireAuth, async (req, res) => {
  try {
    const { year, month } = req.query;
    const usuario_id = req.userId;

    let query = supabase
      .from("calendar_outfits")
      .select("*")
      .eq("usuario_id", usuario_id)
      .order("fecha", { ascending: true });

    if (year && month) {
      const y = String(year);
      const m = String(month).padStart(2, "0");
      const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
      query = query.gte("fecha", `${y}-${m}-01`).lte("fecha", `${y}-${m}-${lastDay}`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    fallar(res, "get calendario", err);
  }
});

app.post("/api/calendario", requireAuth, async (req, res) => {
  try {
    const { fecha, imagen_url, descripcion, metadata } = req.body;
    if (!fecha) return res.status(400).json({ error: "Falta fecha" });

    const { data, error } = await supabase
      .from("calendar_outfits")
      .upsert(
        { usuario_id: req.userId, fecha, imagen_url, descripcion, metadata: metadata || {} },
        { onConflict: "usuario_id,fecha" }
      )
      .select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    fallar(res, "post calendario", err);
  }
});

app.delete("/api/calendario/:id", requireAuth, async (req, res) => {
  try {
    const { data: entry } = await supabase
      .from("calendar_outfits").select("usuario_id").eq("id", req.params.id).single();
    if (!entry) return res.status(404).json({ error: "No encontrado" });
    if (entry.usuario_id !== req.userId) return res.status(403).json({ error: "Sin permiso" });

    const { error } = await supabase.from("calendar_outfits").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    fallar(res, "delete calendario", err);
  }
});

/* ─────────────────────────────────────
   🔥 RACHA DE OUTFITS
───────────────────────────────────── */
app.get("/api/racha", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { data, error } = await supabase
      .from("calendario")
      .select("fecha")
      .eq("usuario_id", usuario_id)
      .order("fecha", { ascending: false });

    if (error) {
      console.error("🔥 racha query:", error.message);
      return res.json({ racha: 0, ultimaFecha: null, registroHoy: false });
    }

    res.json(calcularRacha((data || []).map(e => e.fecha), fechaHoy()));
  } catch (err) {
    fallar(res, "racha", err);
  }
});

/* ─────────────────────────────────────
   ⚠️ MANEJO DE ERRORES
───────────────────────────────────── */
app.use((err, req, res, _next) => {
  if (res.headersSent) return _next(err);
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "JSON inválido" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Petición demasiado grande" });
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Archivo demasiado grande (máx 10 MB)" });
    }
    return res.status(400).json({ error: "Archivo inválido" });
  }
  if (err.status === 415) return res.status(415).json({ error: "Tipo de archivo no permitido" });
  if (err.message === "CORS no permitido") return res.status(403).json({ error: "CORS no permitido" });
  fallar(res, "error no controlado", err);
});

/* ─────────────────────────────────────
   🚀 START
───────────────────────────────────── */
const PORT = process.env.PORT || 5001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Backend corriendo en http://0.0.0.0:${PORT}`);
});
