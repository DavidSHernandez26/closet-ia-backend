// Generador de combinaciones que cumplen una regla de color (y el clima).
import { colorDe, cumpleRegla, detectarRegla } from "./reglas.js";
import { normalizarTipo, subtipoAccesorio } from "./outfit.js";
import { puntuarCandidato } from "./estilo.js";

// Tope de combinaciones evaluadas. Si el producto cartesiano (bases × calzado × abrigo ×
// opciones de accesorios) lo supera, se evalúa una muestra aleatoria de este tamaño.
export const MAX_COMBINACIONES = 20000;
// Umbrales de clima (sensación térmica en °C, lluvia en %).
export const ABRIGO_SI_MENOS_DE = 18;
export const LLUVIA_ABRIGO_MIN = 40;
export const SIN_ABRIGO_SI_MAS_DE = 25;
export const SIN_VERANO_SI_MENOS_DE = 12;
export const SIN_INVIERNO_SI_MAS_DE = 25;
export const MAX_ACCESORIOS = 2;
export const MIN_DIFERENCIA = 2; // prendas distintas entre dos candidatos elegidos
const JITTER = 0.01; // desempate aleatorio para variar entre pedidos iguales

const PADRE = { "azul marino": "azul", denim: "azul", beige: "café" };
const PRENDA_CALOR = /\bshorts?\b|bermuda|sandalia|chancla/;

const sensacion = (clima) => {
  const v = Number(clima?.feels ?? clima?.temp);
  return clima && Number.isFinite(v) ? v : null;
};
const tipoDe = (p) => normalizarTipo(p.descripcion || "", p.metadata_ia || {});
const texto = (p) => `${p.metadata_ia?.nombre || ""} ${p.descripcion || ""}`.toLowerCase();

function temporadaSolo(p, estacion) {
  const t = String(p.metadata_ia?.temporada || "").toLowerCase();
  const otra = estacion === "verano" ? "invierno" : "verano";
  return t.includes(estacion) && !t.includes(otra) && !/todo|todas|all/.test(t);
}

export function aptaParaClima(prenda, clima) {
  const s = sensacion(clima);
  if (s === null) return true;
  if (tipoDe(prenda) === "abrigo" && s > SIN_ABRIGO_SI_MAS_DE) return false;
  if (s < SIN_VERANO_SI_MENOS_DE && (PRENDA_CALOR.test(texto(prenda)) || temporadaSolo(prenda, "verano"))) return false;
  if (s > SIN_INVIERNO_SI_MAS_DE && temporadaSolo(prenda, "invierno")) return false;
  return true;
}

function abrigoSegunClima(clima) {
  const s = sensacion(clima);
  if (s !== null && s > SIN_ABRIGO_SI_MAS_DE) return "prohibido";
  const lluvia = Number(clima?.rain_prob);
  if ((s !== null && s < ABRIGO_SI_MENOS_DE) || (Number.isFinite(lluvia) && lluvia >= LLUVIA_ABRIGO_MIN)) return "obligatorio";
  return "opcional";
}

const familiaExcluida = (p, excluir) => {
  const f = colorDe(p)?.familia;
  return !!f && (excluir.includes(f) || excluir.includes(PADRE[f]));
};

const diferencia = (a, b) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return Math.max(a.filter((x) => !sb.has(x)).length, b.filter((x) => !sa.has(x)).length);
};

// Opciones de accesorios extra (sin repetir subtipo), además de los fijos.
function opcionesAccesorios(pool, fijos) {
  const libres = MAX_ACCESORIOS - fijos.length;
  const ops = [[]];
  if (libres <= 0) return ops;
  const usados = new Set(fijos.map(subtipoAccesorio));
  const disp = pool.filter((a) => !usados.has(subtipoAccesorio(a)));
  for (let i = 0; i < disp.length; i++) {
    ops.push([disp[i]]);
    if (libres < 2) continue;
    for (let j = i + 1; j < disp.length; j++) {
      if (subtipoAccesorio(disp[i]) !== subtipoAccesorio(disp[j])) ops.push([disp[i], disp[j]]);
    }
  }
  return ops;
}

// Índices del producto cartesiano: todos, o una muestra aleatoria sin repetir.
function* indices(total) {
  if (total <= MAX_COMBINACIONES) {
    for (let i = 0; i < total; i++) yield i;
    return;
  }
  const vistos = new Set();
  while (vistos.size < MAX_COMBINACIONES) {
    const i = Math.floor(Math.random() * total);
    if (!vistos.has(i)) { vistos.add(i); yield i; }
  }
}

export function generarCandidatos({
  prendas, regla, familias = [], clima = null, excluirIds = [], excluirTipos = [], excluirFamilias = [],
  fijas = [], max = 6, estilo = null, idsRecientes = [],
} = {}) {
  const todas = (prendas || []).filter((p) => p && p.tipo !== "outfit");
  const porId = new Map(todas.map((p) => [String(p.id), p]));
  const fijasP = (fijas || []).map((f) => (typeof f === "object" ? f : porId.get(String(f)))).filter(Boolean);
  const idsFijos = new Set(fijasP.map((p) => String(p.id)));
  const exIds = new Set((excluirIds || []).map(String));
  const fams = regla ? familias || [] : [];

  const pool = todas.filter((p) =>
    !idsFijos.has(String(p.id)) && colorDe(p) && aptaParaClima(p, clima) && !exIds.has(String(p.id))
    && !(excluirTipos || []).includes(tipoDe(p)) && !familiaExcluida(p, excluirFamilias || []));

  const grupo = (tipo) => pool.filter((p) => tipoDe(p) === tipo);
  const fija = (tipo) => fijasP.filter((p) => tipoDe(p) === tipo);
  const slot = (tipo) => (fija(tipo).length ? [fija(tipo)[0]] : grupo(tipo));

  // Bases: superior + inferior, o vestido (nunca mezclados).
  const bases = [];
  const fijaVestido = fija("vestido").length > 0;
  const fijaPartes = fija("parte superior").length > 0 || fija("parte inferior").length > 0;
  if (!fijaVestido) {
    for (const s of slot("parte superior")) for (const i of slot("parte inferior")) bases.push([s, i]);
  }
  if (!fijaPartes) for (const v of slot("vestido")) bases.push([v]);
  if (!bases.length) return [];

  const calzados = slot("calzado");
  const optCalzado = calzados.length ? calzados : [null];
  const abrigos = slot("abrigo");
  const modo = fija("abrigo").length ? "obligatorio" : abrigoSegunClima(clima);
  const optAbrigo = modo === "prohibido" ? [null] : modo === "obligatorio" ? (abrigos.length ? abrigos : [null]) : [null, ...abrigos];
  const accFijos = fija("accesorio");
  const optAcc = opcionesAccesorios(grupo("accesorio"), accFijos);
  const otrasFijas = fijasP.filter((p) => !["parte superior", "parte inferior", "vestido", "calzado", "abrigo", "accesorio"].includes(tipoDe(p)));

  const dims = [bases.length, optCalzado.length, optAbrigo.length, optAcc.length];
  const total = dims.reduce((a, b) => a * b, 1);
  const validos = [];
  const nucleoConAcc = new Set(); // núcleos con al menos una versión válida con accesorio extra

  for (let idx of indices(total)) {
    const a = idx % dims[3]; idx = Math.floor(idx / dims[3]);
    const ab = idx % dims[2]; idx = Math.floor(idx / dims[2]);
    const ca = idx % dims[1]; const b = Math.floor(idx / dims[1]);
    const piezas = [...bases[b], optCalzado[ca], optAbrigo[ab], ...accFijos, ...optAcc[a], ...otrasFijas].filter(Boolean);
    const r = regla ? (cumpleRegla(piezas, regla, fams) ? regla : null) : detectarRegla(piezas);
    if (!r) continue;
    const nucleo = `${b}|${ca}|${ab}`;
    if (optAcc[a].length) nucleoConAcc.add(nucleo);
    validos.push({ piezas, regla: r, nucleo, sinAcc: !optAcc[a].length });
  }

  // De 1 a 2 accesorios si hay alguno compatible; sin accesorio solo si no lo hay.
  const candidatos = validos
    .filter((v) => !(v.sinAcc && !accFijos.length && nucleoConAcc.has(v.nucleo)))
    .map((v) => {
      const c = { ids: v.piezas.map((p) => String(p.id)), prendas: v.piezas, regla: v.regla, puntaje: 0 };
      c.puntaje = puntuarCandidato(c, estilo, idsRecientes);
      return { c, orden: c.puntaje + Math.random() * JITTER };
    })
    .sort((x, y) => y.orden - x.orden)
    .map((x) => x.c);

  // Selección variada: con regla libre, primero el mejor de cada regla; luego por puntaje.
  const elegidos = [];
  const tomar = (c) => {
    if (elegidos.length >= max || elegidos.includes(c)) return;
    if (elegidos.every((e) => diferencia(e.ids, c.ids) >= MIN_DIFERENCIA)) elegidos.push(c);
  };
  if (!regla) {
    const vistas = new Set();
    for (const c of candidatos) if (!vistas.has(c.regla)) { vistas.add(c.regla); tomar(c); }
  }
  for (const c of candidatos) {
    if (elegidos.length >= max) break;
    tomar(c);
  }
  return elegidos.sort((x, y) => y.puntaje - x.puntaje);
}

export function candidatosGuardados(outfitsGuardados, regla, familias = []) {
  const out = [];
  for (const o of outfitsGuardados || []) {
    const piezas = Array.isArray(o?.metadata_ia?.prendas) ? o.metadata_ia.prendas : null;
    if (!piezas?.length) continue;
    const r = regla ? (cumpleRegla(piezas, regla, familias || []) ? regla : null) : detectarRegla(piezas);
    if (r) out.push({ ids: [String(o.id)], prendas: [o], regla: r, puntaje: 0 });
  }
  return out;
}
