import { normalizarTipo } from "./outfit.js";

export const REGLAS = ["monocromatico", "dos_colores", "analogos", "complementarios", "triada", "neutros_acento"];
export const NOMBRE_REGLA = {
  monocromatico: "Monocromático",
  dos_colores: "Dos colores",
  analogos: "Análogos",
  complementarios: "Complementarios",
  triada: "Tríada",
  neutros_acento: "Neutros + acento",
};

export const ARCO_ANALOGO = 60;
export const TOL_COMPLEMENTO = 30;
export const TOL_TRIADA = 30;
export const RADIO_GRUPO = 30; // máx. distancia de un tono al centro de su grupo

const VARIANTES = { "azul marino": "azul", denim: "azul", beige: "café" };

export function colorDe(prenda) {
  return prenda?.metadata_ia?.color_medible || prenda?.color_medible || null;
}

export function cuentaParaRegla(prenda) {
  const c = colorDe(prenda);
  if (!c) return false;
  const tipo = prenda.descripcion
    ? normalizarTipo(prenda.descripcion, prenda.metadata_ia || {})
    : String(prenda.tipo || "").toLowerCase().trim();
  if ((tipo === "calzado" || tipo === "accesorio") && (c.neutro || c.familia === "café")) return false;
  return true;
}

// Familia efectiva y si es neutra, aplicando variantes solo si se pidió la familia padre.
function efectivo(c, familias) {
  const padre = VARIANTES[c.familia];
  if (padre && familias.includes(padre)) return { familia: padre, neutro: false, h: c.h };
  return { familia: c.familia, neutro: !!c.neutro, h: c.h };
}

const distCirc = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// Arco mínimo circular que cubre los tonos: { centro, arc }.
function arcoYCentro(hs) {
  const s = [...hs].sort((a, b) => a - b);
  if (s.length === 1) return { centro: s[0], arc: 0 };
  let maxGap = -1;
  let ini = s[0];
  for (let i = 0; i < s.length; i++) {
    const sig = (i + 1) % s.length;
    const gap = (s[sig] - s[i] + 360) % 360;
    if (gap > maxGap) { maxGap = gap; ini = s[sig]; }
  }
  const arc = 360 - maxGap;
  return { centro: (ini + arc / 2) % 360, arc };
}

const arcoMinimo = (hs) => arcoYCentro(hs).arc;

// Particiona los tonos en k grupos contiguos (cortando k huecos circulares) y devuelve
// los centros de cada partición cuyos tonos quedan a <= RADIO_GRUPO de su centro.
function* agrupaciones(hs, k) {
  const s = [...hs].sort((a, b) => a - b);
  const n = s.length;
  if (n < k) return;
  const combos = (start, left, acc) =>
    left === 0 ? [acc] : Array.from({ length: n - start }, (_, i) => start + i).flatMap((g) => combos(g + 1, left - 1, [...acc, g]));
  for (const cortes of combos(0, k, [])) {
    const grupos = cortes.map((c, idx) => {
      const g = [];
      for (let i = (c + 1) % n; ; i = (i + 1) % n) {
        g.push(s[i]);
        if (i === cortes[(idx + 1) % k]) break;
      }
      return arcoYCentro(g);
    });
    if (grupos.every((g) => g.arc / 2 <= RADIO_GRUPO)) yield grupos.map((g) => g.centro);
  }
}

export function cumpleRegla(prendas, regla, familias = []) {
  const items = (prendas || []).filter(cuentaParaRegla).map((p) => efectivo(colorDe(p), familias));
  if (!items.length) return false;
  const noNeutros = items.filter((i) => !i.neutro);

  switch (regla) {
    case "monocromatico": {
      const cuenta = new Map();
      for (const i of items) cuenta.set(i.familia, (cuenta.get(i.familia) || 0) + 1);
      let principal;
      if (familias.length) {
        principal = familias[0];
        if (!cuenta.has(principal)) return false;
      } else {
        principal = [...cuenta.entries()].sort((a, b) => b[1] - a[1] || (items.find((i) => i.familia === a[0]).neutro ? 1 : 0) - (items.find((i) => i.familia === b[0]).neutro ? 1 : 0))[0][0];
      }
      const otras = items.filter((i) => i.familia !== principal);
      return cuenta.get(principal) >= 2 && otras.length <= 1 && otras.every((i) => i.neutro);
    }
    case "dos_colores": {
      const set = new Set(items.map((i) => i.familia));
      if (set.size !== 2) return false;
      return familias.length ? familias.length === 2 && familias.every((f) => set.has(f)) : true;
    }
    case "analogos":
      return noNeutros.length >= 2 && arcoMinimo(noNeutros.map((i) => i.h)) <= ARCO_ANALOGO;
    case "complementarios": {
      for (const [a, b] of agrupaciones(noNeutros.map((i) => i.h), 2)) {
        if (Math.abs(distCirc(a, b) - 180) <= TOL_COMPLEMENTO) return true;
      }
      return false;
    }
    case "triada": {
      for (const [a, b, c] of agrupaciones(noNeutros.map((i) => i.h), 3)) {
        if ([[a, b], [b, c], [a, c]].every(([x, y]) => Math.abs(distCirc(x, y) - 120) <= TOL_TRIADA)) return true;
      }
      return false;
    }
    case "neutros_acento":
      return noNeutros.length === 1;
    default:
      return false;
  }
}

const ORDEN = ["monocromatico", "neutros_acento", "complementarios", "triada", "analogos", "dos_colores"];

export function detectarRegla(prendas, familias = []) {
  return ORDEN.find((r) => cumpleRegla(prendas, r, familias)) || null;
}
