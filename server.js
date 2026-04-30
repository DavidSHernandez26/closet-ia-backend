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

const upload = multer({ dest: "uploads/" });
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
   🧼 REMOVE BACKGROUND (local, sin API externa)
   Usa @imgly/background-removal-node — corre en el mismo proceso Node.js.
   model "medium" para outfits, "large" para prenda individual.
───────────────────────────────────── */
async function removeBackground(imageBuffer, quality = "large") {
  try {
    console.log(`🧼 Removiendo fondo local (calidad: ${quality}), buffer:`, imageBuffer.length);

    const { removeBackground: imglyRemoveBg } = await import("@imgly/background-removal-node");

    // Redimensionar a 1000px máximo para reducir uso de RAM en Railway free tier
    const pngBuffer = await sharp(imageBuffer)
      .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const blob = new Blob([pngBuffer], { type: "image/png" });

    // "small" (~40MB) cabe en el plan gratuito de Railway (512MB RAM)
    const resultBlob = await imglyRemoveBg(blob, {
      model: "small",
      output: { format: "image/png", quality: 1 },
    });

    const buffer = Buffer.from(await resultBlob.arrayBuffer());
    console.log(`🧼 Fondo removido OK (${quality}), resultado:`, buffer.length, "bytes");
    return buffer;
  } catch (err) {
    console.error("⚠️ removeBackground excepción:", err.message, err.stack);
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

app.put("/api/perfil", async (req, res) => {
  try {
    const { usuario_id, username, nombre, bio } = req.body;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });

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
app.post("/api/amistad/solicitar", async (req, res) => {
  try {
    const { requester_id, addressee_id } = req.body;
    if (!requester_id || !addressee_id) return res.status(400).json({ error: "Faltan datos" });
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

    const { data: fromProfile } = await supabase
      .from("profiles").select("username").eq("id", requester_id).single();

    await crearNotificacion({
      usuario_id: addressee_id,
      from_usuario_id: requester_id,
      tipo: "solicitud",
      mensaje: `@${fromProfile?.username || "alguien"} te envió una solicitud de amistad`,
    });

    res.json({ mensaje: "✅ Solicitud enviada", data });
  } catch (err) {
    console.error("🔥 solicitar amistad:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/amistad/responder", async (req, res) => {
  try {
    const { friendship_id, status, usuario_id } = req.body;
    if (!friendship_id || !status || !usuario_id) return res.status(400).json({ error: "Faltan datos" });

    const { data, error } = await supabase
      .from("friendships")
      .update({ status })
      .eq("id", friendship_id)
      .eq("addressee_id", usuario_id)
      .select().single();
    if (error) throw error;

    if (status === "accepted") {
      const { data: fromProfile } = await supabase
        .from("profiles").select("username").eq("id", usuario_id).single();
      await crearNotificacion({
        usuario_id: data.requester_id,
        from_usuario_id: usuario_id,
        tipo: "aceptado",
        mensaje: `@${fromProfile?.username || "alguien"} aceptó tu solicitud de amistad 🎉`,
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
app.post("/api/subir-prenda", aiLimiter, upload.single("imagen"), async (req, res) => {
  try {
    const { usuario_id, genero = "unisex", tipo = "prenda", imagen_url } = req.body;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });
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
      console.log("👕 Modo: prenda individual — quitando fondo (calidad alta)...");
      const sinFondo = await removeBackground(imagenOriginalBuffer, "large");
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
- Para el tipo: usa únicamente: calzado, parte superior, parte inferior, accesorio, abrigo.`,
            },
            { type: "image_url", image_url: { url: imagenOriginalUrl, detail: "high" } },
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
            { type: "image_url", image_url: { url: imagenOriginalUrl, detail: "high" } },
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
app.get("/api/prendas", async (req, res) => {
  try {
    const { usuario_id, tipo } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });
    let query = supabase.from("prendas").select("*").eq("usuario_id", usuario_id).order("created_at", { ascending: false });
    if (tipo && tipo !== "todos") query = query.eq("tipo", tipo);
    const { data, error } = await query;
    if (error) throw error;
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
    res.json({ mensaje: "🗑️ Eliminado" });
  } catch (err) {
    console.error("🔥 delete:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────
   👗 FASHION IA
───────────────────────────────────── */
app.post("/api/fashion", aiLimiter, async (req, res) => {
  try {
    const { usuario_id, mensaje, historial = [], outfit_ids_anteriores = [] } = req.body;
    if (!usuario_id || !mensaje) return res.status(400).json({ error: "Faltan datos" });

    const { data: prendas, error } = await supabase
      .from("prendas").select("id, descripcion, imagen_url, tipo, metadata_ia").eq("usuario_id", usuario_id);
    if (error) throw error;

    if (!prendas || prendas.length === 0) {
      return res.json({
        respuesta: "No tienes prendas registradas aún. ¡Sube algunas fotos de tu closet para que pueda ayudarte!",
        outfit: [], outfit_guardado: null, cambiar_panel: false,
      });
    }

    const prendasSueltas = prendas.filter((p) => p.tipo === "prenda");
    const outfitsGuardados = prendas.filter((p) => p.tipo === "outfit");

    const contextoPrendas = prendasSueltas.length > 0
      ? "PRENDAS SUELTAS DISPONIBLES (formato: [ID] nombre (color) - tipo):\n" +
        prendasSueltas.map((p) => `[ID:${p.id}] ${p.descripcion}`).join("\n")
      : "No hay prendas sueltas disponibles.";

    const contextoOutfits = outfitsGuardados.length > 0
      ? "\n\nOUTFITS GUARDADOS (solo referencia de estilo):\n" +
        outfitsGuardados.map((p) => {
          const lista = p.metadata_ia?.prendas?.map((x) => `${x.nombre} (${x.color})`).join(", ") || "";
          return `[ID:${p.id}] ${p.descripcion}${lista ? ` — incluye: ${lista}` : ""}`;
        }).join("\n")
      : "";

    const prendasActuales = prendasSueltas.filter((p) => outfit_ids_anteriores.includes(p.id));
    const contextoActual = prendasActuales.length > 0
      ? "\n\nOUTFIT ACTUAL EN PANTALLA:\n" +
        prendasActuales.map((p) => `[ID:${p.id}] ${p.descripcion}`).join("\n")
      : "";

    const historialTexto = historial.length > 0
      ? "\n\nHISTORIAL DE CONVERSACIÓN:\n" +
        historial.map((h) => `${h.role === "user" ? "Usuario" : "Asistente"}: ${h.text}`).join("\n")
      : "";

    const ai = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: `Eres un estilista personal experto con amplio conocimiento en teoría del color, tendencias de moda y combinación de prendas.

CONTEXTO DEL CLOSET:
Las prendas tienen este formato: nombre (color) - tipo
Tipos posibles: parte superior, parte inferior, calzado, accesorio, abrigo

REGLAS DE COMBINACIÓN:

1. ESTRUCTURA DEL OUTFIT — siempre respeta esta jerarquía:
   - 1 parte superior (obligatorio si hay disponibles)
   - 1 parte inferior (obligatorio si hay disponibles)
   - 1 calzado (obligatorio si hay disponible)
   - 1-2 accesorios máximo (opcional, solo si complementan el look)
   - 1 abrigo (opcional, solo si el usuario lo pide o la ocasión lo requiere)

2. TEORÍA DEL COLOR — aplica estas reglas al recomendar:
   - Neutros (negro, blanco, beige, gris, camel, café) combinan con absolutamente todo
   - Colores análogos (cercanos en el círculo cromático) crean looks armoniosos y cohesivos
   - Colores complementarios (opuestos en el círculo) crean contraste elegante y dinámico
   - Máximo 3 colores por outfit para no saturar visualmente
   - Colores llamativos (rosa, morado, rojo, amarillo) funcionan mejor como pieza focal única, combinados con neutros
   - Colores oscuros (negro, azul marino, café oscuro) son versátiles y elegantes
   - El denim (azul) es neutro y combina con casi todo

3. OCASIONES — adapta el outfit según lo que pida el usuario:
   - Casual/diario: prendas cómodas, sneakers, colores relajados, accesorios simples
   - Formal/oficina: prendas estructuradas, colores neutros o sobrios, menos accesorios
   - Cita/salida nocturna: combinaciones más cuidadas, accesorios estratégicos, look pulido
   - Sport/activo: funcionalidad + estilo, colores deportivos
   - Si el usuario no especifica, deduce la ocasión por el tono de su mensaje

4. EXCLUSIONES ABSOLUTAS:
   - Si el usuario dice "sin X", "no quiero X", "quita X", esa prenda JAMÁS aparece en outfit_ids
   - Esta regla es inquebrantable, no hay excepciones

5. CONTINUIDAD Y MEMORIA:
   - Recuerda exactamente qué recomendaste antes en el historial
   - Si el usuario pide un cambio, mantén las prendas que no mencionó y modifica solo lo pedido
   - Si pide algo completamente nuevo, propón una combinación fresca diferente

6. CALIDAD DE LA RESPUESTA:
   - Explica brevemente por qué los colores elegidos funcionan juntos
   - Menciona para qué ocasión es ideal el look
   - Señala cómo se complementan las prendas entre sí
   - Si es relevante, da un tip de estilo
   - Tono: cálido, cercano, como un amigo con buen gusto que te asesora
   - Responde siempre en español

7. CONTROL DEL PANEL:
   - "cambiar_panel": true → si el usuario pide outfit nuevo, diferente, o quiere ver algo distinto
   - "cambiar_panel": false → si solo pide consejo en texto, mejora, pregunta algo, o comenta el outfit actual

8. REGLA DE ORO:
   - outfit_ids SOLO puede contener IDs de PRENDAS SUELTAS
   - NUNCA incluyas IDs de outfits guardados en outfit_ids

Devuelve SIEMPRE y ÚNICAMENTE este JSON exacto sin ningún texto antes ni después:
{"respuesta":"explicación detallada y cercana del outfit","outfit_ids":[id1,id2,id3],"cambiar_panel":true}`,
        },
        {
          role: "user",
          content: `${contextoPrendas}${contextoOutfits}${contextoActual}${historialTexto}\n\nMensaje del usuario: ${mensaje}`,
        },
      ],
      max_tokens: 800,
      temperature: 0.8,
    });

    const parsed = safeParseJSON(ai.choices[0].message.content);

    if (!parsed) {
      const fallback = [...prendasSueltas].sort(() => Math.random() - 0.5).slice(0, 3);
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

    const outfit = prendasSueltas.filter((p) => parsed.outfit_ids?.includes(p.id));
    const fallback = [...prendasSueltas].sort(() => Math.random() - 0.5).slice(0, 3);

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
app.post("/api/posts", upload.single("imagen"), async (req, res) => {
  try {
    const { usuario_id, descripcion, prendas } = req.body;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });
    if (!req.file) return res.status(400).json({ error: "Falta imagen" });

    const buffer = await fs.promises.readFile(req.file.path);
    const rotated = await sharp(buffer).rotate().toBuffer();

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

app.get("/api/feed", async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });

    const { data: amistades } = await supabase
      .from("friendships")
      .select("requester_id, addressee_id")
      .or(`requester_id.eq.${usuario_id},addressee_id.eq.${usuario_id}`)
      .eq("status", "accepted");

    const amigoIds = (amistades || []).map((f) =>
      f.requester_id === usuario_id ? f.addressee_id : f.requester_id
    );
    const todosIds = [usuario_id, ...amigoIds];

    const { data: posts, error } = await supabase
      .from("posts")
      .select(`id, imagen_url, descripcion, prendas, created_at, usuario_id, profile:usuario_id(id, username, nombre, avatar_url)`)
      .in("usuario_id", todosIds)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    const postIds = (posts || []).map((p) => p.id);
    const postsConData = postIds.length === 0 ? [] : await enrichPosts(posts, postIds, usuario_id);

    res.json(postsConData);
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
app.post("/api/likes", async (req, res) => {
  try {
    const { post_id, usuario_id } = req.body;
    if (!post_id || !usuario_id) return res.status(400).json({ error: "Faltan datos" });

    const { data: existing } = await supabase
      .from("likes").select("id").eq("post_id", post_id).eq("usuario_id", usuario_id).single();

    if (existing) {
      await supabase.from("likes").delete().eq("id", existing.id);
      return res.json({ liked: false });
    }

    await supabase.from("likes").insert([{ post_id, usuario_id }]);

    const { data: post } = await supabase.from("posts").select("usuario_id").eq("id", post_id).single();
    const { data: fromProfile } = await supabase.from("profiles").select("username").eq("id", usuario_id).single();

    if (post?.usuario_id) {
      await crearNotificacion({
        usuario_id: post.usuario_id,
        from_usuario_id: usuario_id,
        tipo: "like",
        mensaje: `@${fromProfile?.username || "alguien"} le dio ❤️ a tu outfit`,
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
      .eq("post_id", post_id).order("created_at", { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("🔥 get comments:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/comments", async (req, res) => {
  try {
    const { post_id, usuario_id, texto } = req.body;
    if (!post_id || !usuario_id || !texto?.trim()) return res.status(400).json({ error: "Faltan datos" });

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

app.delete("/api/comments/:id", async (req, res) => {
  try {
    const { id } = req.params;
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
app.get("/api/wishlist", async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });
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

app.post("/api/wishlist", async (req, res) => {
  try {
    const { usuario_id, post_id, imagen_url, descripcion } = req.body;
    if (!usuario_id || !post_id) return res.status(400).json({ error: "Faltan datos" });

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

app.delete("/api/wishlist/:id", async (req, res) => {
  try {
    const { id } = req.params;
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

app.put("/api/notificaciones/leer", async (req, res) => {
  try {
    const { usuario_id } = req.body;
    if (!usuario_id) return res.status(400).json({ error: "Falta usuario_id" });

    const { error } = await supabase
      .from("notifications")
      .update({ leida: true })
      .eq("usuario_id", usuario_id)
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
   🚀 START
───────────────────────────────────── */
const PORT = process.env.PORT || 5001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Backend corriendo en http://0.0.0.0:${PORT}`);
});