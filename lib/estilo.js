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

export function aprenderEstilo({ calendario = [], prendasSueltas = [], outfitsGuardados = [] } = {}) {
  const porId = new Map();
  for (const p of prendasSueltas || []) porId.set(String(p.id), [p]);
  for (const o of outfitsGuardados || []) porId.set(String(o.id), piezasDe([o]));

  const reglas = {};
  const familias = {};
  const sumar = (piezas, reglaGuardada) => {
    if (!piezas.length) return;
    let r = detectarRegla(piezas);
    if (!r && REGLAS.includes(reglaGuardada)) r = reglaGuardada;
    if (r) reglas[r] = (reglas[r] || 0) + 1;
    for (const p of piezas.filter(cuentaParaRegla)) {
      const f = colorDe(p).familia;
      familias[f] = (familias[f] || 0) + 1;
    }
  };

  for (const e of calendario || []) {
    const ids = Array.isArray(e?.metadata?.outfit_ids) ? e.metadata.outfit_ids : [];
    sumar(ids.flatMap((id) => porId.get(String(id)) || []), e?.metadata?.regla);
  }
  for (const o of outfitsGuardados || []) sumar(piezasDe([o]), null);

  return { reglas: normalizar(reglas), familias: normalizar(familias) };
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
