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
  const tipo = normalizarTipo(prenda.descripcion || "", prenda.metadata_ia || {});
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

function arcoMinimo(hs) {
  const s = [...hs].sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 0; i < s.length; i++) {
    const gap = i === s.length - 1 ? s[0] + 360 - s[i] : s[i + 1] - s[i];
    if (gap > maxGap) maxGap = gap;
  }
  return s.length < 2 ? 0 : 360 - maxGap;
}

// Devuelve los centros de k grupos (cortes en k huecos circulares) donde cada tono
// queda a <= RADIO_GRUPO del centro, o null.
function* agrupaciones(hs, k) {
  const s = [...hs].sort((a, b) => a - b);
  const n = s.length;
  if (n < k) return;
  const gaps = Array.from({ length: n }, (_, i) => i); // hueco i: entre s[i] y s[(i+1)%n]
  const combos = (start, left, acc) => (left === 0 ? [acc] : gaps.slice(start).flatMap((g) => combos(g + 1, left - 1, [...acc, g])));
  for (const cortes of combos(0, k, [])) {
    const grupos = cortes.map((c, idx) => {
      const ini = (c + 1) % n;
      const fin = cortes[(idx + 1) % k];
      const g = [];
      for (let i = ini; ; i = (i + 1) % n) {
        g.push(s[i]);
        if (i === fin) break;
      }
      return g;
    });
    const centros = grupos.map((g) => {
      const arc = arcoMinimo(g);
      let ini = g[0];
      // inicio del arco: el tono tras el mayor hueco
      const gs = [...g];
      let best = -1;
      for (let i = 0; i < gs.length; i++) {
        const gap = (gs[(i + 1) % gs.length] - gs[i] + 360) % 360 || (gs.length === 1 ? 360 : 0);
        if (gap > best) { best = gap; ini = gs[(i + 1) % gs.length]; }
      }
      return { centro: (ini + arc / 2) % 360, arc };
    });
    if (centros.every((c) => c.arc / 2 <= RADIO_GRUPO)) yield centros.map((c) => c.centro);
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
      return otras.length <= 1 && otras.every((i) => i.neutro);
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

const ORDEN = ["monocromatico", "neutros_acento", "dos_colores", "complementarios", "triada", "analogos"];

export function detectarRegla(prendas, familias = []) {
  return ORDEN.find((r) => cumpleRegla(prendas, r, familias)) || null;
}
