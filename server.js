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
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
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

const upload = multer({ dest: "uploads/", limits: { fileSize: 10 * 1024 * 1024 } });
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

function normalizarTipo(descripcion = "") {
  const d = descripcion.toLowerCase();
  const parts = d.split(" - ");
  const tipoAlmacenado = parts[parts.length - 1]?.trim() || "otro";
  const nombreParte = parts.slice(0, -1).join(" ");
  // Sudaderas y hoodies van en la misma capa que chaquetas → abrigo
  if (
    tipoAlmacenado === "parte superior" &&
    (nombreParte.includes("sudadera") || nombreParte.includes("hoodie") || nombreParte.includes("sweatshirt"))
  ) {
    return "abrigo";
  }
  return tipoAlmacenado;
}

function deduplicarPorTipo(prendas) {
  const seen = new Map();
  for (const p of [...prendas].sort(() => Math.random() - 0.5)) {
    const tipo = normalizarTipo(p.descripcion);
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

app.post("/api/perfil/avatar", upload.single("avatar"), async (req, res) => {
  try {
    const { usuario_id } = req.body;
    if (!usuario_id || !req.file) return res.status(400).json({ error: "Faltan datos" });

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

app.get("/api/amistad/solicitudes", async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });
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

app.get("/api/amistad/amigos", async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });
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
Analiza esta prenda con mucho cuidado y devuelve SOLO este JSON:
{
  "nombre": "tenis",
  "color": "café/marrón",
  "tipo": "calzado"
}
Reglas estrictas:
- Para el color: sé muy específico (café, marrón, beige, crema, burdeos, mostaza, camel, terracota, verde oliva, azul marino, etc). NO uses colores genéricos.
- Si hay varios colores menciona el principal: "negro con blanco".
- Para el nombre: usa el término correcto (tenis, botines, mocasines, chaqueta, sudadera, hoodie, polo, blusa, etc).
- Para el tipo: usa únicamente: calzado, parte superior, parte inferior, accesorio, abrigo.
- Sudaderas, hoodies, chaquetas, chamarras, blazers, sacos → tipo SIEMPRE "abrigo".`,
            },
            { type: "image_url", image_url: { url: imagenOriginalUrl, detail: "low" } },
          ],
        }],
        temperature: 0,
        max_tokens: 200,
      });

      const parsed = safeParseJSON(ai.choices[0].message.content);
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
   👗 FASHION IA
───────────────────────────────────── */

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
    const contextoClima = clima
      ? `\n\nCLIMA ACTUAL: ${clima}\nAdapta telas y capas: abrigo si <15°C o lluvia, ligero si >25°C, medio si 15-25°C.`
      : "";

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

1. ESTRUCTURA — selecciona EXACTAMENTE UNO por categoría:
   • 1 parte superior (OBLIGATORIO)
   • 1 parte inferior (OBLIGATORIO)
   • 1 calzado (OBLIGATORIO)
   • 1 accesorio máximo (OPCIONAL — solo si suma al look)
   • 1 abrigo (OPCIONAL — solo si el clima o la ocasión lo requiere)
   ✗ NUNCA 2 prendas del mismo tipo en outfit_ids
   ✗ Sudadera y chaqueta = mismo tipo (abrigo). Solo una.

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

8. CALIDAD DE RESPUESTA:
   • Explica el "por qué" de cada elección (color, textura, ocasión)
   • Menciona cómo las proporciones/fits se complementan
   • Da 1 tip de estilo accionable
   • Tono: cercano, seguro, como un amigo con buen gusto
   • Responde siempre en español

9. CONTROL DEL PANEL:
   • "cambiar_panel": true → usuario pide outfit nuevo o diferente
   • "cambiar_panel": false → solo pide consejo, comenta, o hace pregunta

10. REGLA DE ORO:
    • outfit_ids SOLO contiene IDs de PRENDAS SUELTAS (tipo=prenda)
    • NUNCA IDs de outfits guardados

Devuelve SIEMPRE y ÚNICAMENTE este JSON (sin texto antes ni después):
{"respuesta":"explicación cálida y detallada","outfit_ids":[id1,id2,id3],"cambiar_panel":true}`,
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
app.get("/api/notificaciones/count", async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });

    const { count, error } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("usuario_id", usuario_id)
      .eq("leida", false);

    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (err) {
    console.error("🔥 notif count:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/notificaciones", async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });

    const { data, error } = await supabase
      .from("notifications")
      .select(`
        id, tipo, mensaje, leida, created_at, post_id,
        from_profile:from_user_id(id, username, nombre, avatar_url)
      `)
      .eq("usuario_id", usuario_id)
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

app.delete("/api/notificaciones/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("notifications").delete().eq("id", id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error("🔥 delete notif:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/notificaciones", async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });

    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("usuario_id", usuario_id);

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
app.get("/api/calendario", async (req, res) => {
  try {
    const { usuario_id, year, month } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });

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
   🚀 START
───────────────────────────────────── */
const PORT = process.env.PORT || 5001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Backend corriendo en http://0.0.0.0:${PORT}`);
});