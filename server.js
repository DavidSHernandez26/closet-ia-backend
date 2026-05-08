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

dotenv.config();

const app = express();
app.set("trust proxy", 1); // necesario para Railway (proxy inverso)
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));
const _corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map(o => o.trim())
  : [];
// Orígenes de la app nativa (Capacitor Android / iOS WebView)
const _nativeOrigins = ["https://localhost", "http://localhost", "capacitor://localhost"];
app.use(cors({
  origin: (origin, cb) => {
    // Sin lista configurada → permitir todo
    if (_corsOrigins.length === 0) return cb(null, true);
    // Sin origin (curl, Postman) → permitir
    if (!origin) return cb(null, true);
    // App nativa Capacitor → siempre permitir
    if (_nativeOrigins.includes(origin)) return cb(null, true);
    // Verificar si el origin está en la lista de producción
    _corsOrigins.includes(origin) ? cb(null, true) : cb(new Error("CORS no permitido"));
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

// Fix 7 — rate limit en endpoints con IA (OpenAI + rembg)
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

async function cleanupFile(path) {
  if (path) fs.unlink(path, () => {});
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MODEL = "gpt-4o-mini";

/* ─────────────────────────────────────
   🔐 AUTH MIDDLEWARE (Fix 2)
   Verifica el JWT de Supabase y adjunta req.userId
───────────────────────────────────── */
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No autenticado" });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Token inválido" });
  req.userId = user.id;
  next();
}

/* ─────────────────────────────────────
   🧠 PARSE JSON
───────────────────────────────────── */
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

function normalizarTipo(descripcion = "", metaIa = {}) {
  // Prioridad: metadata_ia.tipo > tipo al final de la descripción
  const tipoMeta = (metaIa?.tipo || "").toLowerCase().trim();
  const d = descripcion.toLowerCase();
  const parts = d.split(" - ");
  const tipoDesc = parts[parts.length - 1]?.trim() || "";
  const nombreParte = parts.slice(0, -1).join(" ");
  const tipo = tipoMeta || tipoDesc || "otro";

  // Vestido / jumpsuit / mono completo — categoría propia
  if (tipo === "vestido" || /vestido|dress|jumpsuit|mono completo|enterizo/.test(nombreParte)) return "vestido";

  // Sudaderas y hoodies van con abrigo
  if (tipo === "parte superior" && /sudadera|hoodie|sweatshirt/.test(nombreParte)) return "abrigo";

  return tipo;
}

function subtipoAccesorio(p) {
  const texto = ((p.metadata_ia?.nombre || '') + ' ' + (p.descripcion || '')).toLowerCase();
  if (/gorra|cap|sombrero|boina|snapback|beanie/.test(texto))           return 'gorra';
  if (/cintur[oó]n|belt|correa/.test(texto))                            return 'cinturon';
  if (/reloj|watch/.test(texto))                                        return 'reloj';
  if (/manilla|pulsera|brazalete/.test(texto))                          return 'manilla';
  if (/collar|cadena|colgante|necklace/.test(texto))                    return 'collar';
  if (/bandolera|crossbody/.test(texto))                                return 'bandolera';
  if (/bolso|cartera|tote|clutch|maletín/.test(texto))                  return 'bolso';
  if (/mochila|backpack/.test(texto))                                   return 'mochila';
  if (/lentes|gafas|anteojos|sunglasses/.test(texto))                   return 'lentes';
  if (/bufanda|pa[ñn]uelo|scarf/.test(texto))                           return 'bufanda';
  // fallback: primer token del nombre en metadata_ia
  return (p.metadata_ia?.nombre || 'misc').toLowerCase().split(' ')[0];
}

function deduplicarPorTipo(prendas) {
  const tipos = prendas.map(p => normalizarTipo(p.descripcion, p.metadata_ia));
  const hayVestido = tipos.includes("vestido");

  const seen = new Map();
  const seenAccesorios = new Set();
  let accesoriosCount = 0;

  for (let i = 0; i < prendas.length; i++) {
    const p    = prendas[i];
    const tipo = tipos[i];

    // Con vestido: no incluir parte superior ni parte inferior
    if (hayVestido && (tipo === "parte superior" || tipo === "parte inferior")) continue;

    // Accesorios: máx 1 por sub-tipo (1 gorra, 1 cinturón, 1 reloj…)
    if (tipo === "accesorio") {
      const sub = subtipoAccesorio(p);
      if (!seenAccesorios.has(sub)) {
        seenAccesorios.add(sub);
        seen.set(`accesorio_${accesoriosCount}`, p);
        accesoriosCount++;
      }
      continue;
    }

    if (!seen.has(tipo)) seen.set(tipo, p);
  }
  return [...seen.values()];
}

function safeParseJSON(content) {
  try {
    const text = Array.isArray(content)
      ? content.map((c) => c.text || "").join("")
      : content;
    const jsonStr = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────
   📥 DESCARGAR IMAGEN
───────────────────────────────────── */
async function descargarImagen(url) {
  try {
    console.log("📥 Descargando imagen:", url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    console.log("📥 Buffer size:", buffer.length, "bytes");
    return buffer;
  } catch (err) {
    console.error("⚠️ Error descargando imagen:", err.message);
    return null;
  }
}

/* ─────────────────────────────────────
   🧼 REMOVE BACKGROUND (via Hugging Face Space)
   model: "birefnet-general" para prenda individual (alta calidad)
───────────────────────────────────── */
async function removeBackground(imageBuffer, model = "birefnet-general") {
  try {
    const rembgUrl = process.env.REMBG_SERVICE_URL;
    if (!rembgUrl) {
      console.warn("⚠️ REMBG_SERVICE_URL no configurado, omitiendo remoción de fondo");
      return null;
    }

    // 512px es suficiente para el closet y procesa ~4x más rápido que 800px en CPU
    const resizedBuffer = await sharp(imageBuffer)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    console.log(`🧼 Enviando a HF Space (${model}), buffer reducido:`, resizedBuffer.length);
    const formData = new FormData();
    formData.append("file", resizedBuffer, { filename: "prenda.jpg", contentType: "image/jpeg" });
    formData.append("model", model);

    const res = await fetch(`${rembgUrl}/remove-bg`, {
      method: "POST",
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
    console.log(`🧼 Fondo removido OK (${model}), resultado:`, buffer.length, "bytes");
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
app.get("/api/perfil/me", async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });
    const { data, error } = await supabase
      .from("profiles").select("*").eq("id", usuario_id).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("🔥 perfil/me:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 perfil/:username:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/usuarios/buscar", async (req, res) => {
  try {
    const { q, usuario_id } = req.query;
    if (!q) return res.json([]);
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, nombre, avatar_url")
      .ilike("username", `%${q}%`)
      .neq("id", usuario_id || "")
      .limit(10);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("🔥 buscar usuarios:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────
   ✨ SUGERIDOS — usuarios que el usuario
   actual no conoce todavía (ni amigos
   ni solicitudes pendientes).
   Usado por el sidebar del Feed.
───────────────────────────────────── */
app.get("/api/usuarios/sugeridos", async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });

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
    console.error("🔥 sugeridos:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/perfil", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { username, nombre, bio } = req.body;

    if (username) {
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
    console.error("🔥 put perfil:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 avatar:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 solicitar amistad:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/amistad/responder", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { friendship_id, status } = req.body;
    if (!friendship_id || !status) return res.status(400).json({ error: "Faltan datos" });

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
    console.error("🔥 responder amistad:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 solicitudes:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/amistad/amigos", requireAuth, async (req, res) => {
  try {
    const usuario_id = req.query.usuario_id || req.userId;
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
    console.error("🔥 amigos:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/amistad/estado", async (req, res) => {
  try {
    const { usuario_id, otro_id } = req.query;
    if (!usuario_id || !otro_id) return res.status(400).json({ error: "Faltan datos" });
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
    console.error("🔥 eliminar amistad:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/prendas/amigo/:amigo_id", async (req, res) => {
  try {
    const { amigo_id } = req.params;
    const { usuario_id, tipo } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });

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
    console.error("🔥 prendas amigo:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────
   📸 SUBIR PRENDA / OUTFIT
───────────────────────────────────── */
app.post("/api/subir-prenda", requireAuth, aiLimiter, upload.single("imagen"), async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { genero = "unisex", tipo = "prenda", imagen_url } = req.body;
    if (!req.file && !imagen_url) return res.status(400).json({ error: "No se envió imagen" });

    let imagenOriginalUrl = imagen_url;
    let imagenOriginalBuffer = null;

    if (req.file) {
      imagenOriginalBuffer = await fs.promises.readFile(req.file.path);
      console.log("📁 Archivo recibido directo, size:", imagenOriginalBuffer.length);
    } else {
      imagenOriginalBuffer = await descargarImagen(imagenOriginalUrl);
      if (!imagenOriginalBuffer) throw new Error("No se pudo descargar la imagen");
    }

    imagenOriginalBuffer = await sharp(imagenOriginalBuffer).rotate().toBuffer();

    if (tipo === "prenda") {
      console.log("👕 Modo: prenda individual — quitando fondo con isnet-general-use...");
      const sinFondo = await removeBackground(imagenOriginalBuffer, "isnet-general-use");
      const bufferFinal = sinFondo || imagenOriginalBuffer;
      const tieneFondo = !sinFondo;
      if (tieneFondo) console.log("⚠️ rembg falló, usando imagen original");

      const cleanName = `${usuario_id}_${Date.now()}_prenda.png`;
      const { error: uploadError } = await supabase.storage
        .from("prendas").upload(cleanName, bufferFinal, { contentType: "image/png" });
      if (uploadError) throw uploadError;

      imagenOriginalUrl = supabase.storage.from("prendas").getPublicUrl(cleanName).data.publicUrl;
      console.log("📤 Imagen subida:", imagenOriginalUrl);

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
  "fit": "regular"
}
Reglas para cada campo:
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

      const parsed = safeParseJSON(ai.choices[0].message.content);

      // Si la IA detecta que no es una prenda, eliminar de storage y rechazar
      if (parsed?.tipo === "no_prenda") {
        await supabase.storage.from("prendas").remove([cleanName]);
        return res.status(422).json({ error: "La imagen no parece contener una prenda de ropa, calzado o accesorio." });
      }

      const nombre = parsed?.nombre || "prenda";
      const color = parsed?.color || "?";
      const tipoPrenda = parsed?.tipo || "?";
      const descripcion = `${nombre} (${color}) - ${tipoPrenda}`;
      console.log("👕 Detectado:", descripcion);

      await supabase.from("prendas").insert([{
        usuario_id, tipo: "prenda", genero,
        imagen_url: imagenOriginalUrl,
        descripcion, metadata_ia: parsed || {},
      }]);
      invalidatePrendasCache(usuario_id);

      return res.json({
        mensaje: tieneFondo
          ? "✅ Prenda guardada (fondo no removido)"
          : "✅ Prenda guardada sin fondo",
      });
    }

    if (tipo === "outfit") {
      console.log("🧥 Modo: outfit completo");
      const outfitName = `${usuario_id}_${Date.now()}_outfit.jpg`;
      const { error: uploadError } = await supabase.storage
        .from("prendas").upload(outfitName, imagenOriginalBuffer, { contentType: "image/jpeg" });
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
    { "nombre": "camiseta", "color": "blanco", "tipo": "parte superior" },
    { "nombre": "pantalón cargo", "color": "verde oliva", "tipo": "parte inferior" }
  ],
  "descripcion_outfit": "Outfit casual con camiseta blanca y pantalón cargo verde oliva"
}
Reglas: colores específicos, nombres correctos, tipos: calzado/parte superior/parte inferior/accesorio/abrigo. Incluye TODAS las prendas visibles.`,
            },
            { type: "image_url", image_url: { url: imagenOriginalUrl, detail: "low" } },
          ],
        }],
        temperature: 0,
        max_tokens: 800,
      });

      const parsed = safeParseJSON(ai.choices[0].message.content);
      const prendasDetectadas = parsed?.prendas || [];
      const descripcionOutfit = parsed?.descripcion_outfit || "Outfit completo";
      console.log("🧥 Prendas detectadas:", prendasDetectadas.length);

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
    console.error("🔥 subir-prenda:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 get prendas:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────
   ❌ ELIMINAR PRENDA
───────────────────────────────────── */
app.delete("/api/prendas/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: prenda } = await supabase.from("prendas").select("usuario_id").eq("id", id).single();
    if (!prenda) return res.status(404).json({ error: "Prenda no encontrada" });
    if (prenda.usuario_id !== req.userId) return res.status(403).json({ error: "Sin permiso" });
    const { error } = await supabase.from("prendas").delete().eq("id", id);
    if (error) throw error;
    invalidatePrendasCache(req.userId);
    res.json({ mensaje: "🗑️ Eliminado" });
  } catch (err) {
    console.error("🔥 delete:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────
   🔄 RE-ANÁLISIS DE PRENDAS EXISTENTES
   Enriquece metadata_ia con material, temporada, estilo, patrón, fit
───────────────────────────────────── */
app.post("/api/prendas/reanalizar", requireAuth, aiLimiter, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { data: prendas, error } = await supabase
      .from("prendas")
      .select("id, imagen_url, descripcion, metadata_ia")
      .eq("usuario_id", usuario_id)
      .eq("tipo", "prenda");

    if (error) throw error;
    if (!prendas || prendas.length === 0)
      return res.json({ mensaje: "No hay prendas para analizar.", actualizadas: 0 });

    // Solo prendas que no tienen los campos nuevos
    const pendientes = prendas.filter(p => {
      const m = p.metadata_ia || {};
      return !m.material || !m.temporada || !m.estilo || !m.patron || !m.fit;
    });

    if (pendientes.length === 0)
      return res.json({ mensaje: "Todas las prendas ya tienen metadata completa.", actualizadas: 0 });

    let actualizadas = 0;
    const LOTE = 5; // de a 5 para no saturar la API

    for (let i = 0; i < pendientes.length; i += LOTE) {
      const lote = pendientes.slice(i, i + LOTE);
      await Promise.allSettled(lote.map(async (prenda) => {
        try {
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
  "fit": "..."
}
tipo: calzado | parte superior | parte inferior | accesorio | abrigo | vestido
  abrigo = chaquetas/sudaderas/hoodies/blazers
  vestido = vestidos/monos/jumpsuits/enterizos
  accesorio = gorras/bolsos/relojes/manillas/collares/cinturones/lentes
material: algodón, denim, cuero, lana, lino, poliéster, punto, sintético, seda...
temporada: verano | invierno | primavera/otoño | todo el año
estilo: casual | formal | deportivo | streetwear | elegante | bohemio | minimalista
patron: liso | rayas | cuadros | floral | estampado | camuflaje | animal print
fit: slim | regular | oversized | ajustado | holgado`,
                },
                { type: "image_url", image_url: { url: prenda.imagen_url, detail: "low" } },
              ],
            }],
            temperature: 0,
            max_tokens: 300,
          });

          const parsed = safeParseJSON(ai.choices[0].message.content);
          if (!parsed) return;

          const metaActual = prenda.metadata_ia || {};
          const metaNueva = {
            nombre:    parsed.nombre    || metaActual.nombre    || "",
            color:     parsed.color     || metaActual.color     || "",
            tipo:      parsed.tipo      || metaActual.tipo      || "",
            material:  parsed.material  || metaActual.material  || "",
            temporada: parsed.temporada || metaActual.temporada || "",
            estilo:    parsed.estilo    || metaActual.estilo    || "",
            patron:    parsed.patron    || metaActual.patron    || "",
            fit:       parsed.fit       || metaActual.fit       || "",
          };

          const nombre = metaNueva.nombre || prenda.descripcion.split(" (")[0];
          const color  = metaNueva.color  || prenda.descripcion.match(/\(([^)]+)\)/)?.[1] || "?";
          const tipo   = metaNueva.tipo   || prenda.descripcion.split(" - ").pop() || "?";

          await supabase.from("prendas").update({
            metadata_ia: metaNueva,
            descripcion: `${nombre} (${color}) - ${tipo}`,
          }).eq("id", prenda.id);

          actualizadas++;
        } catch (e) {
          console.error(`🔥 reanalizar prenda ${prenda.id}:`, e.message);
        }
      }));
    }

    invalidatePrendasCache(usuario_id);
    res.json({ mensaje: `✅ ${actualizadas} de ${pendientes.length} prendas actualizadas.`, actualizadas, total: pendientes.length });
  } catch (err) {
    console.error("🔥 reanalizar:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────
   👗 FASHION IA
───────────────────────────────────── */

/* Genera contexto climático obligatorio y accionable para la IA */
function generarContextoClima(c) {
  if (!c || typeof c !== "object") {
    return `\n\nCLIMA: No disponible. Aplica igual criterio climático usando la metadata de temporada/material de cada prenda. Si hay prendas de abrigo disponibles, priorízalas ante la duda.`;
  }

  const { temp, feels, wind = 0, city = "tu ciudad", label = "", rain_prob = 0 } = c;
  const sensacion = feels ?? temp;

  let capaRegla, telas, urgencia;
  if      (sensacion < 5)  { urgencia = "🥶 FRÍO EXTREMO";  capaRegla = "ABRIGO GRUESO OBLIGATORIO — sin él el outfit es inadecuado para salir";   telas = "lana, polar, plumas, pana, denim grueso"; }
  else if (sensacion < 12) { urgencia = "🧥 FRÍO";          capaRegla = "CHAQUETA O ABRIGO OBLIGATORIO — debe aparecer en outfit_ids si existe";    telas = "lana, algodón grueso, punto, denim"; }
  else if (sensacion < 18) { urgencia = "🌤 FRESCO";        capaRegla = "Capa media RECOMENDADA: suéter, cardigan o chaqueta ligera";               telas = "algodón, denim ligero, punto fino"; }
  else if (sensacion < 25) { urgencia = "🌿 TEMPLADO";      capaRegla = "Sin capas pesadas — temperatura agradable, prioriza comodidad";            telas = "algodón, mezclas ligeras, denim"; }
  else                     { urgencia = "☀️ CALOR";          capaRegla = "Ropa ligera y transpirable OBLIGATORIA — NUNCA abrigos ni suéteres gruesos"; telas = "lino, algodón ligero, tejidos transpirables"; }

  const lluviaLinea = rain_prob >= 40
    ? `\n• Lluvia: ${rain_prob}% de probabilidad → incluye abrigo impermeable/capa resistente al agua si el closet lo tiene; EVITA lino, seda, ante/suede`
    : "";
  const vientoLinea = wind >= 25
    ? `\n• Viento: ${wind} km/h → prioriza prendas con cierre completo o fit ajustado`
    : "";

  return `\n\n${urgencia} EN ${city.toUpperCase()} — REGLAS CLIMÁTICAS (NO NEGOCIABLES):
• Temperatura: ${temp}°C · Sensación térmica: ${sensacion}°C · Condición: ${label}${lluviaLinea}${vientoLinea}
• ${capaRegla}
• Telas apropiadas para ${sensacion}°C: ${telas}

⚠️ EL CLIMA ES PRIORIDAD ABSOLUTA: un outfit que ignora ${sensacion}°C de sensación térmica es incorrecto, sin importar qué tan bien combine visualmente.`;
}

/* Formatea una prenda con toda su metadata estructurada */
function formatPrendaRica(p) {
  const m = p.metadata_ia || {};
  const partes = [`[ID:${p.id}] ${p.descripcion}`];
  if (m.tipo)       partes.push(`  • tipo: ${m.tipo}`);
  if (m.color)      partes.push(`  • color: ${m.color}`);
  if (m.material)   partes.push(`  • material: ${m.material}`);
  if (m.temporada)  partes.push(`  • temporada: ${m.temporada}`);
  if (m.estilo)     partes.push(`  • estilo: ${m.estilo}`);
  if (m.patron)     partes.push(`  • patrón: ${m.patron}`);
  if (m.fit)        partes.push(`  • fit: ${m.fit}`);
  return partes.join("\n");
}

app.post("/api/fashion", requireAuth, aiLimiter, async (req, res) => {
  try {
    const usuario_id = req.userId;
    const { mensaje, historial = [], outfit_ids_anteriores = [], clima } = req.body;
    if (!mensaje) return res.status(400).json({ error: "Faltan datos" });
    if (!Array.isArray(historial) || !Array.isArray(outfit_ids_anteriores))
      return res.status(400).json({ error: "Formato inválido" });

    /* ── Carga en paralelo: prendas + perfil + calendario reciente ── */
    let prendas = getCachedPrendas(usuario_id);

    const [prendasResult, perfilResult, calendarioResult] = await Promise.allSettled([
      prendas
        ? Promise.resolve({ data: prendas })
        : supabase.from("prendas").select("*").eq("usuario_id", usuario_id).order("created_at", { ascending: false }),
      supabase.from("profiles").select("nombre, bio, genero").eq("id", usuario_id).single(),
      supabase.from("calendario")
        .select("fecha, descripcion, metadata")
        .eq("usuario_id", usuario_id)
        .gte("fecha", (() => { const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString().split("T")[0]; })())
        .order("fecha", { ascending: false })
        .limit(10),
    ]);

    if (!prendas) {
      prendas = prendasResult.status === "fulfilled" ? (prendasResult.value.data || []) : [];
      if (prendas.length) setCachedPrendas(usuario_id, prendas);
    }

    const perfil = perfilResult.status === "fulfilled" ? perfilResult.value.data : null;
    const calendarioReciente = calendarioResult.status === "fulfilled" ? (calendarioResult.value.data || []) : [];

    if (!prendas || prendas.length === 0) {
      return res.json({
        respuesta: "No tienes prendas registradas aún. ¡Sube algunas fotos de tu closet para que pueda ayudarte!",
        outfit: [], outfit_guardado: null, cambiar_panel: false,
      });
    }

    const prendasSueltas = prendas.filter((p) => p.tipo === "prenda");
    const outfitsGuardados = prendas.filter((p) => p.tipo === "outfit");

    /* ── Contexto 1: Prendas con metadata completa ── */
    const contextoPrendas = prendasSueltas.length > 0
      ? "PRENDAS DISPONIBLES EN EL CLOSET:\n" +
        prendasSueltas.map(formatPrendaRica).join("\n\n")
      : "No hay prendas sueltas disponibles.";

    /* ── Contexto 2: Outfits guardados ── */
    const contextoOutfits = outfitsGuardados.length > 0
      ? "\n\nOUTFITS GUARDADOS (referencia de estilo del usuario):\n" +
        outfitsGuardados.map((p) => {
          const lista = p.metadata_ia?.prendas?.map((x) => `${x.nombre} (${x.color})`).join(", ") || "";
          return `[ID:${p.id}] ${p.descripcion}${lista ? ` — incluye: ${lista}` : ""}`;
        }).join("\n")
      : "";

    /* ── Contexto 3: Outfit actual en pantalla ── */
    const prendasActuales = prendasSueltas.filter((p) => outfit_ids_anteriores.includes(p.id));
    const contextoActual = prendasActuales.length > 0
      ? "\n\nOUTFIT ACTUAL EN PANTALLA:\n" +
        prendasActuales.map(formatPrendaRica).join("\n\n")
      : "";

    /* ── Contexto 4: Calendario — qué usó recientemente ── */
    const IDS_RECIENTES = new Set();
    const contextoCalendario = calendarioReciente.length > 0
      ? "\n\nOUTFITS USADOS RECIENTEMENTE (últimos 14 días — EVITA repetir estas combinaciones):\n" +
        calendarioReciente.map((e) => {
          const ids = e.metadata?.outfit_ids || [];
          ids.forEach(id => IDS_RECIENTES.add(id));
          const prendNames = ids.length
            ? prendasSueltas.filter(p => ids.includes(p.id)).map(p => p.descripcion.split(" - ")[0]).join(", ")
            : e.descripcion || "outfit sin detalle";
          return `• ${e.fecha}: ${prendNames}`;
        }).join("\n")
      : "";

    /* ── Contexto 5: Perfil del usuario ── */
    const contextoPerfil = perfil
      ? (() => {
          const partes = [];
          if (perfil.nombre)  partes.push(`Nombre: ${perfil.nombre}`);
          if (perfil.genero)  partes.push(`Género: ${perfil.genero}`);
          if (perfil.bio)     partes.push(`Bio/Estilo personal: "${perfil.bio}"`);
          return partes.length ? `\n\nPERFIL DEL USUARIO:\n${partes.join("\n")}` : "";
        })()
      : "";

    /* ── Contexto 6: Historial de conversación ── */
    const historialTexto = historial.length > 0
      ? "\n\nHISTORIAL DE CONVERSACIÓN:\n" +
        historial.map((h) => `${h.role === "user" ? "Usuario" : "Asistente"}: ${h.text}`).join("\n")
      : "";

    /* ── Contexto 7: Clima ── */
    const contextoClima = generarContextoClima(clima);

    /* ── Aviso de prendas usadas recientemente ── */
    const prendas_usadas_ids = [...IDS_RECIENTES];
    const avisoRepeticion = prendas_usadas_ids.length > 0
      ? `\n\nADVERTENCIA DE REPETICIÓN: Los IDs [${prendas_usadas_ids.join(", ")}] fueron usados en los últimos 14 días. Prioriza prendas que NO estén en esa lista para generar variedad real.`
      : "";

    const ai = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: `Eres un estilista personal experto con conocimiento profundo de teoría del color, tendencias actuales y psicología de la moda.

Tu misión: armar el outfit más inteligente posible usando EXACTAMENTE las prendas del closet del usuario. Conoces su estilo, lo que ha usado recientemente, y el contexto del día.

═══════════════════════════════════════
REGLAS DE COMBINACIÓN
═══════════════════════════════════════

1. ESTRUCTURA DEL OUTFIT — elige UNA de estas dos plantillas según el closet:

   ── PLANTILLA A: CLÁSICO (sin vestido) ──
   • 1 parte superior — camiseta, camisa, polo, blusa (OBLIGATORIO)
   • 1 parte inferior — pantalón, jean, short, falda (OBLIGATORIO)
   • 1 calzado (OBLIGATORIO)
   • 1 abrigo — chaqueta, sudadera, blazer (OBLIGATORIO si sensación < 18°C o lluvia ≥ 40%; omitir si > 25°C)
   • accesorios — gorra, bandolera/bolso, reloj, manilla, collar, cinturón, lentes, bufanda (incluye TODOS los que tengas disponibles y que realmente aporten al look; sin límite)

   ── PLANTILLA B: VESTIDO / JUMPSUIT / MONO ──
   • 1 vestido / jumpsuit / mono completo (reemplaza parte superior + inferior — NUNCA añadir pantalón ni camiseta)
   • 1 calzado (OBLIGATORIO)
   • 1 abrigo (OBLIGATORIO si sensación < 18°C; OPCIONAL si templado; OMITIR si > 25°C)
   • accesorios (todos los disponibles que aporten — sin límite)

   REGLAS GLOBALES:
   ✗ NUNCA mezclar plantillas (vestido + pantalón = error grave)
   ✗ NUNCA 2 prendas del mismo tipo (ej: 2 abrigos)
   ✗ Sudadera y chaqueta = mismo tipo (abrigo). Solo una.
   ✓ Si no hay abrigo disponible y hace frío, díselo en la respuesta
   ✓ Incluye accesorios siempre que existan en el closet y complementen el look

2. TEORÍA DEL COLOR:
   • Neutros (negro, blanco, beige, gris, camel, marino) van con todo
   • Análogos (colores cercanos en la rueda) = look armonioso
   • Complementarios (opuestos) = contraste sofisticado
   • Máximo 3 colores por outfit
   • Colores vivos (rosa, rojo, amarillo) = una sola pieza focal + neutros
   • Denim azul se comporta como neutro

3. METADATA DETALLADA — usa los campos estructurados de cada prenda:
   • "material" afecta la formalidad y la estación (lino = verano, lana = invierno)
   • "fit" afecta proporciones (oversized arriba = ajustado abajo, y viceversa)
   • "patrón" afecta combinación (estampado + liso, nunca 2 estampados juntos)
   • "temporada" es una restricción hard — no uses ropa de invierno en verano

4. VARIEDAD REAL — mira los outfits recientes del usuario:
   • Si una prenda se usó en los últimos 7 días, EVÍTALA a menos que no haya alternativa
   • Si se usó hace 8-14 días, úsala solo si es la claramente mejor opción
   • El usuario merece ver combinaciones nuevas cada día

5. PERSONALIZACIÓN — usa el perfil del usuario:
   • Su bio/estilo personal revela preferencias reales (minimalista, colorido, sport, etc.)
   • Adapta la elección a ese estilo cuando la ocasión lo permita
   • Si indica género, ajusta la silueta y proporciones apropiadas

6. EXCLUSIONES ABSOLUTAS:
   • Si el usuario dice "sin X" o "no quiero X", esa prenda NUNCA aparece
   • Sin excepciones ni interpretaciones

7. CONTINUIDAD Y EDICIÓN:
   • Si pide cambiar solo una pieza, mantén el resto igual
   • Si pide algo completamente nuevo, rompe con lo anterior y sorprende

8. ESTRUCTURA DE RESPUESTA OBLIGATORIA:
   La "respuesta" debe seguir SIEMPRE este formato (sin etiquetas HTML, solo texto y emojis):

   Una frase de apertura que nombre el look/ocasión (ej. "Un look casual chic perfecto para el día 🌿")

   Luego, por cada prenda seleccionada, una línea con este formato exacto:
   • [nombre de la prenda] — [razón específica: color, fit, material, cómo combina con las demás]

   Finalmente, 1 tip de estilo accionable (empieza con "💡 Tip:").

   Ejemplo de respuesta correcta:
   "Look urbano relajado para un día de actividades 🧢

   • Hoodie gris oversized — el gris actúa como neutro y el fit holgado equilibra el look con el pantalón ajustado
   • Jean slim negro — contrasta en fit con la parte superior y alarga la silueta
   • Tenis blancos — ancla el outfit con un punto limpio que abre el espacio visual

   💡 Tip: dobla ligeramente el borde del jean para mostrar el tobillo y dar un toque más intencional al look."

   Tono: cercano, seguro, como un amigo con buen gusto. Responde siempre en español.

9. CONTROL DEL PANEL:
   • "cambiar_panel": true → usuario pide outfit nuevo o diferente
   • "cambiar_panel": false → solo pide consejo, comenta, o hace pregunta

10. REGLA DE ORO:
    • outfit_ids SOLO contiene IDs de PRENDAS SUELTAS (tipo=prenda)
    • NUNCA IDs de outfits guardados

Devuelve SIEMPRE y ÚNICAMENTE este JSON (sin texto antes ni después):
{"respuesta":"[respuesta con el formato del punto 8]","outfit_ids":[id1,id2,id3],"cambiar_panel":true}`,
        },
        {
          role: "user",
          content: `${contextoPerfil}${contextoClima}${contextoPrendas}${contextoOutfits}${contextoActual}${contextoCalendario}${avisoRepeticion}${historialTexto}\n\nMensaje del usuario: ${mensaje}`,
        },
      ],
      max_tokens: 900,
      temperature: 0.7,
    });

    const parsed = safeParseJSON(ai.choices[0].message.content);

    if (!parsed) {
      const fallback = deduplicarPorTipo([...prendasSueltas].sort(() => Math.random() - 0.5));
      return res.json({
        respuesta: "Te armé una combinación con lo que tienes disponible. ¡Pruébala y dime qué piensas!",
        outfit: fallback, outfit_guardado: null, cambiar_panel: true,
      });
    }

    const cambiarPanel = parsed.cambiar_panel ?? true;
    const outfitGuardadoRecomendado = outfitsGuardados.find((p) => parsed.outfit_ids?.includes(p.id));

    if (outfitGuardadoRecomendado) {
      return res.json({
        respuesta: parsed.respuesta,
        outfit: [], outfit_guardado: outfitGuardadoRecomendado, cambiar_panel: cambiarPanel,
      });
    }

    const outfitBruto = prendasSueltas.filter((p) => parsed.outfit_ids?.includes(p.id));
    const outfit = deduplicarPorTipo(outfitBruto);
    const fallback = deduplicarPorTipo([...prendasSueltas].sort(() => Math.random() - 0.5));

    res.json({
      respuesta: parsed.respuesta || "Aquí tienes un outfit que combina muy bien.",
      outfit: outfit.length ? outfit : fallback,
      outfit_guardado: null,
      cambiar_panel: cambiarPanel,
    });
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
app.post("/api/recomendaciones-compra", requireAuth, async (req, res) => {
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
    const parsed = safeParseJSON(ai.choices[0].message.content);
    res.json({ recomendaciones: parsed?.recomendaciones || [] });
  } catch (err) {
    console.error("📊 recomendaciones:", err.message);
    res.status(500).json({ recomendaciones: [] });
  }
});

/* ─────────────────────────────────────
   🔢 HELPER — enrich posts (Fix 1: evita N+1 queries)
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

    // Fix 6 — JSON.parse seguro
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
    console.error("🔥 crear post:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 feed:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 posts usuario:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/posts/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: post } = await supabase.from("posts").select("usuario_id").eq("id", id).single();
    if (!post) return res.status(404).json({ error: "Post no encontrado" });
    if (post.usuario_id !== req.userId) return res.status(403).json({ error: "Sin permiso" });
    const { error } = await supabase.from("posts").delete().eq("id", id);
    if (error) throw error;
    res.json({ mensaje: "🗑️ Post eliminado" });
  } catch (err) {
    console.error("🔥 delete post:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 like:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 get comments:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 comentar:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 delete comment:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 wishlist:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 wishlist toggle:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 delete wishlist:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 notif count:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/notificaciones", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("notifications")
      .select(`
        id, tipo, mensaje, leida, created_at, post_id,
        from_profile:from_user_id(id, username, nombre, avatar_url)
      `)
      .eq("usuario_id", req.userId)
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("🔥 notificaciones:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 marcar leidas:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 delete notif:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 delete todas notif:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 get calendario:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 post calendario:", err.message);
    res.status(500).json({ error: err.message });
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
    console.error("🔥 delete calendario:", err.message);
    res.status(500).json({ error: err.message });
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

    // Normalizar a YYYY-MM-DD y deduplicar
    const fechas = [...new Set(
      (data || []).map(e => (e.fecha || "").slice(0, 10)).filter(Boolean)
    )].sort().reverse();

    if (!fechas.length) return res.json({ racha: 0, ultimaFecha: null });

    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const ayer = new Date(hoy); ayer.setDate(ayer.getDate() - 1);
    const ultima = new Date(fechas[0] + "T12:00:00"); ultima.setHours(0, 0, 0, 0);

    // Si el último registro es más antiguo que ayer, la racha se rompió
    if (ultima < ayer) return res.json({ racha: 0, ultimaFecha: fechas[0] });

    let racha = 1;
    let esperada = new Date(ultima); esperada.setDate(esperada.getDate() - 1);

    for (let i = 1; i < fechas.length; i++) {
      const f = new Date(fechas[i] + "T12:00:00"); f.setHours(0, 0, 0, 0);
      if (f.getTime() === esperada.getTime()) {
        racha++;
        esperada.setDate(esperada.getDate() - 1);
      } else if (f < esperada) {
        break;
      }
    }

    // ¿Ya registró outfit hoy?
    const registroHoy = fechas[0] === hoy.toISOString().split("T")[0];

    res.json({ racha, ultimaFecha: fechas[0], registroHoy });
  } catch (err) {
    console.error("🔥 racha:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────
   🚀 START
───────────────────────────────────── */
const PORT = process.env.PORT || 5001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Backend corriendo en http://0.0.0.0:${PORT}`);
});