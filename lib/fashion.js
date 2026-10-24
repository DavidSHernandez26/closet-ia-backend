import { deduplicarPorTipo } from "./outfit.js";

/* Sanitiza el clima del cliente antes de meterlo al prompt (topes de tamaño y tipos). */
export function limpiarClima(clima) {
  if (!clima || typeof clima !== "object" || Array.isArray(clima)) return null;
  const temp = clima.temp == null ? NaN : Number(clima.temp);
  if (!Number.isFinite(temp)) return null;
  const out = { temp };
  for (const k of ["feels", "wind", "rain_prob"]) {
    if (clima[k] == null) continue;
    const n = Number(clima[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  for (const k of ["city", "label"]) {
    if (clima[k] != null) out[k] = String(clima[k]).slice(0, 60);
  }
  return out;
}

/* Tope de IDs de outfits anteriores (controla el tamaño del prompt). */
export function limpiarIdsAnteriores(arr) {
  return arr.slice(0, 30).map(String).filter(s => s.length <= 64);
}

/* Genera contexto climático obligatorio y accionable para la IA */
export function generarContextoClima(c) {
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
export function formatPrendaRica(p) {
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

/* Historial del cliente → solo mensajes con texto, últimos 10, 1000 chars c/u */
export function limpiarHistorial(historial) {
  if (!Array.isArray(historial)) return [];
  return historial
    .filter((h) => h && typeof h.text === "string")
    .slice(-10)
    .map((h) => ({ role: h.role, text: h.text.slice(0, 1000) }));
}

/* Texto del mensaje de usuario que se envía a la IA (perfil, clima, closet, calendario, historial) */
export function construirMensajeUsuario({
  perfil, clima, prendasSueltas, outfitsGuardados, outfitIdsAnteriores,
  calendarioReciente, historial, mensaje,
}) {
  const contextoPrendas = prendasSueltas.length > 0
    ? "PRENDAS DISPONIBLES EN EL CLOSET:\n" + prendasSueltas.map(formatPrendaRica).join("\n\n")
    : "No hay prendas sueltas disponibles.";

  const contextoOutfits = outfitsGuardados.length > 0
    ? "\n\nOUTFITS GUARDADOS (referencia de estilo del usuario):\n" +
      outfitsGuardados.map((p) => {
        const lista = p.metadata_ia?.prendas?.map((x) => `${x.nombre} (${x.color})`).join(", ") || "";
        return `[ID:${p.id}] ${p.descripcion}${lista ? ` — incluye: ${lista}` : ""}`;
      }).join("\n")
    : "";

  const anteriores = new Set(outfitIdsAnteriores.map(String));
  const prendasActuales = prendasSueltas.filter((p) => anteriores.has(String(p.id)));
  const contextoActual = prendasActuales.length > 0
    ? "\n\nOUTFIT YA MOSTRADO AL USUARIO (EVITAR REPETIR — usa prendas distintas):\n" +
      prendasActuales.map(formatPrendaRica).join("\n\n")
    : "";

  const idsRecientes = new Set();
  const contextoCalendario = calendarioReciente.length > 0
    ? "\n\nOUTFITS USADOS RECIENTEMENTE (últimos 14 días — EVITA repetir estas combinaciones):\n" +
      calendarioReciente.map((e) => {
        const ids = Array.isArray(e.metadata?.outfit_ids) ? e.metadata.outfit_ids : [];
        ids.forEach((id) => idsRecientes.add(String(id)));
        const idsStr = new Set(ids.map(String));
        const nombres = ids.length
          ? prendasSueltas.filter((p) => idsStr.has(String(p.id))).map((p) => p.descripcion.split(" - ")[0]).join(", ")
          : e.descripcion || "outfit sin detalle";
        return `• ${e.fecha}: ${nombres}`;
      }).join("\n")
    : "";

  const contextoPerfil = perfil
    ? (() => {
        const partes = [];
        if (perfil.nombre) partes.push(`Nombre: ${perfil.nombre}`);
        if (perfil.genero) partes.push(`Género: ${perfil.genero}`);
        if (perfil.bio)    partes.push(`Bio/Estilo personal: "${perfil.bio}"`);
        return partes.length ? `\n\nPERFIL DEL USUARIO:\n${partes.join("\n")}` : "";
      })()
    : "";

  const historialTexto = historial.length > 0
    ? "\n\nHISTORIAL DE CONVERSACIÓN:\n" +
      historial.map((h) => `${h.role === "user" ? "Usuario" : "Asistente"}: ${h.text}`).join("\n")
    : "";

  const contextoClima = generarContextoClima(clima);

  const excluidos = [...new Set([...idsRecientes, ...outfitIdsAnteriores.map(String)])];
  const avisoRepeticion = excluidos.length > 0
    ? `\n\nEXCLUSIÓN OBLIGATORIA: Los IDs [${excluidos.join(", ")}] NO pueden aparecer en el outfit_ids de tu respuesta. El usuario ya los vio — DEBES elegir prendas completamente diferentes para generar variedad real.`
    : "";

  return `${contextoPerfil}${contextoClima}${contextoPrendas}${contextoOutfits}${contextoActual}${contextoCalendario}${avisoRepeticion}${historialTexto}\n\nMensaje del usuario: ${mensaje}`;
}

/* Convierte la respuesta parseada de la IA en el outfit/sugerencias que ve el cliente */
export function resolverOutfit(parsed, prendasSueltas, outfitsGuardados) {
  const fallback = () => deduplicarPorTipo([...prendasSueltas].sort(() => Math.random() - 0.5));
  if (!parsed) {
    return { outfit: fallback(), outfit_guardado: null, cambiar_panel: true, sugerencias: [] };
  }

  const ids = new Set((Array.isArray(parsed.outfit_ids) ? parsed.outfit_ids : []).map(String));
  const cambiar_panel = parsed.cambiar_panel ?? true;
  const sugerencias = (Array.isArray(parsed.sugerencias) ? parsed.sugerencias.slice(0, 3) : [])
    .map((s) => (typeof s === "string" ? { text: s, action: "chat" } : s))
    .filter((s) => s?.text);

  const guardado = outfitsGuardados.find((p) => ids.has(String(p.id)));
  if (guardado) return { outfit: [], outfit_guardado: guardado, cambiar_panel, sugerencias };

  const outfit = deduplicarPorTipo(prendasSueltas.filter((p) => ids.has(String(p.id))));
  return { outfit: outfit.length ? outfit : fallback(), outfit_guardado: null, cambiar_panel, sugerencias };
}
