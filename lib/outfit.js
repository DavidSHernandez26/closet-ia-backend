// Helpers puros para armar outfits (sin dependencias de red ni de Express).

export function normalizarTipo(descripcion = "", metaIa = {}) {
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

export function subtipoAccesorio(p) {
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

export function deduplicarPorTipo(prendas) {
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

export function safeParseJSON(content) {
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
