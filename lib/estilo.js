// Estilo aprendido en silencio: qué reglas y familias de color usa el usuario.
import { colorDe, cuentaParaRegla, detectarRegla, REGLAS } from "./reglas.js";

// Cuánto resta cada prenda del candidato que el usuario usó hace poco.
export const PENALIZACION_RECIENTE = 0.5;

// Expande un outfit guardado (tipo "outfit") a sus prendas detectadas.
export function piezasDe(prendas) {
  return (prendas || []).flatMap((p) =>
    p?.tipo === "outfit" && Array.isArray(p.metadata_ia?.prendas) ? p.metadata_ia.prendas : [p]
  );
}

export function familiasDe(prendas) {
  return [...new Set(piezasDe(prendas).filter(cuentaParaRegla).map((p) => colorDe(p).familia))];
}

const normalizar = (cuenta) => {
  const total = Object.values(cuenta).reduce((a, b) => a + b, 0);
  if (!total) return {};
  return Object.fromEntries(Object.entries(cuenta).map(([k, v]) => [k, v / total]));
};

// IDs de prendas (u outfit guardado) de una entrada del calendario: outfit_ids; si no hay,
// los ids de metadata.outfit (outfits editados); más outfit_guardado_id si existe.
export function idsDeEntrada(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const conId = (x) => x !== null && x !== undefined && x !== "";
  const ids = (Array.isArray(metadata.outfit_ids) && metadata.outfit_ids.length
    ? metadata.outfit_ids
    : Array.isArray(metadata.outfit) ? metadata.outfit.map((p) => p?.id) : []
  ).filter(conId).map(String);
  if (conId(metadata.outfit_guardado_id) && !ids.includes(String(metadata.outfit_guardado_id))) {
    ids.push(String(metadata.outfit_guardado_id));
  }
  return ids;
}

// Aporte de un conjunto de piezas al estilo: su regla (o la guardada) y sus familias.
function aporte(piezas, reglaGuardada) {
  let r = piezas.length ? detectarRegla(piezas) : null;
  if (!r && piezas.length && REGLAS.includes(reglaGuardada)) r = reglaGuardada;
  return { regla: r, familias: piezas.filter(cuentaParaRegla).map((p) => colorDe(p).familia) };
}

// Conteos sin normalizar (permiten restar el aporte de un outfit, ver estiloSinOutfit).
export function contarEstilo({ calendario = [], prendasSueltas = [], outfitsGuardados = [] } = {}) {
  const porId = new Map();
  for (const p of prendasSueltas || []) porId.set(String(p.id), [p]);
  for (const o of outfitsGuardados || []) porId.set(String(o.id), piezasDe([o]));

  const reglas = {};
  const familias = {};
  const sumar = (piezas, reglaGuardada) => {
    const { regla, familias: fs } = aporte(piezas, reglaGuardada);
    if (regla) reglas[regla] = (reglas[regla] || 0) + 1;
    for (const f of fs) familias[f] = (familias[f] || 0) + 1;
  };

  for (const e of calendario || []) {
    sumar(idsDeEntrada(e?.metadata).flatMap((id) => porId.get(id) || []), e?.metadata?.regla);
  }
  // Las fotos de outfits completos también enseñan el estilo (decisión explícita del usuario).
  for (const o of outfitsGuardados || []) sumar(piezasDe([o]), null);

  return { reglas, familias };
}

export function normalizarEstilo(cuentas) {
  return { reglas: normalizar(cuentas?.reglas || {}), familias: normalizar(cuentas?.familias || {}) };
}

export function aprenderEstilo(args = {}) {
  return normalizarEstilo(contarEstilo(args));
}

// Estilo sin el aporte propio de un outfit guardado, para que no se puntúe a sí mismo.
export function estiloSinOutfit(cuentas, outfit) {
  const { regla, familias: fs } = aporte(piezasDe([outfit]), null);
  const reglas = { ...cuentas.reglas };
  const familias = { ...cuentas.familias };
  if (regla && reglas[regla]) reglas[regla] -= 1;
  for (const f of fs) if (familias[f]) familias[f] -= 1;
  return normalizarEstilo({ reglas, familias });
}

export function puntuarCandidato(candidato, estilo, idsRecientes = []) {
  let puntaje = 0;
  if (estilo) {
    puntaje += estilo.reglas?.[candidato.regla] || 0;
    for (const f of familiasDe(candidato.prendas)) puntaje += estilo.familias?.[f] || 0;
  }
  const recientes = new Set((idsRecientes || []).map(String));
  for (const id of candidato.ids || []) if (recientes.has(String(id))) puntaje -= PENALIZACION_RECIENTE;
  return puntaje;
}
