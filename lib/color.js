// Color medible: convierte un hex en HSL y lo clasifica en una familia de color.

// Umbrales (l y s en 0-100, h en grados 0-360).
export const L_NEGRO_MAX = 12;
export const L_BLANCO_MIN = 92;
export const S_GRIS_MAX = 12;
export const MARINO = { hMin: 200, hMax: 255, lMax: 30, sMin: 25 };
export const DENIM = { hMin: 195, hMax: 235, sMin: 15, sMax: 55, lMin: 30, lMax: 65 };
export const BEIGE = { hMin: 25, hMax: 60, sMax: 60, lMin: 55 };
export const CAFE = { hMin: 10, hMax: 45, lMax: 35 };
export const OLIVA = { hMin: 45, hMax: 70, lMax: 40 }; // amarillo oscuro -> verde
export const ROSA_CLARO = { hMax: 15, hMin: 345, lMin: 72 }; // rojo muy claro -> rosa

// Rangos de matiz para familias cromáticas (hMax exclusivo), en orden.
export const FAMILIAS_POR_MATIZ = [
  { hasta: 15, familia: "rojo" },
  { hasta: 40, familia: "naranja" },
  { hasta: 70, familia: "amarillo" },
  { hasta: 165, familia: "verde" },
  { hasta: 195, familia: "turquesa" },
  { hasta: 255, familia: "azul" },
  { hasta: 315, familia: "morado" },
  { hasta: 345, familia: "rosa" },
  { hasta: 360, familia: "rojo" },
];

const NEUTROS = new Set(["negro", "blanco", "gris", "beige", "azul marino", "denim"]);

export function hexAHsl(hex) {
  if (typeof hex !== "string") return null;
  let m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  let h6 = m?.[1];
  if (!h6) {
    m = hex.trim().match(/^#?([0-9a-f]{3})$/i);
    if (!m) return null;
    h6 = [...m[1]].map((c) => c + c).join("");
  }
  const r = parseInt(h6.slice(0, 2), 16) / 255;
  const g = parseInt(h6.slice(2, 4), 16) / 255;
  const b = parseInt(h6.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

function clasificar({ h, s, l }) {
  if (l <= L_NEGRO_MAX) return "negro";
  if (l >= L_BLANCO_MIN) return "blanco";
  if (s < S_GRIS_MAX) return "gris";
  if (h >= MARINO.hMin && h <= MARINO.hMax && l <= MARINO.lMax && s >= MARINO.sMin) return "azul marino";
  if (h >= DENIM.hMin && h <= DENIM.hMax && s >= DENIM.sMin && s <= DENIM.sMax && l >= DENIM.lMin && l <= DENIM.lMax) return "denim";
  if (h >= BEIGE.hMin && h <= BEIGE.hMax && s <= BEIGE.sMax && l >= BEIGE.lMin) return "beige";
  if (h >= CAFE.hMin && h < CAFE.hMax && l <= CAFE.lMax) return "café";
  if (h >= OLIVA.hMin && h < OLIVA.hMax && l <= OLIVA.lMax) return "verde";
  if ((h < ROSA_CLARO.hMax || h >= ROSA_CLARO.hMin) && l >= ROSA_CLARO.lMin) return "rosa";
  return FAMILIAS_POR_MATIZ.find((r) => h < r.hasta).familia;
}

export function colorMedible(hex) {
  const hsl = hexAHsl(hex);
  if (!hsl) return null;
  const familia = clasificar(hsl);
  const norm = hex.trim().replace(/^#?/, "#").toUpperCase();
  return { hex: norm, ...hsl, familia, neutro: NEUTROS.has(familia) };
}

const sinAcentos = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Orden importa: "azul marino" antes que "azul".
const NOMBRES = [
  ["azul marino", "azul marino"], ["marino", "azul marino"], ["navy", "azul marino"],
  ["denim", "denim"], ["mezclilla", "denim"],
  ["azul", "azul"], ["celeste", "azul"],
  ["negro", "negro"], ["blanco", "blanco"], ["gris", "gris"],
  ["beige", "beige"], ["crema", "beige"], ["camel", "beige"], ["arena", "beige"],
  ["cafe", "café"], ["marron", "café"], ["chocolate", "café"],
  ["rojo", "rojo"], ["burdeos", "rojo"], ["vino", "rojo"], ["guinda", "rojo"],
  ["verde", "verde"], ["oliva", "verde"],
  ["amarillo", "amarillo"], ["mostaza", "amarillo"],
  ["rosa", "rosa"], ["fucsia", "rosa"],
  ["morado", "morado"], ["lila", "morado"], ["violeta", "morado"], ["purpura", "morado"],
  ["naranja", "naranja"], ["turquesa", "turquesa"],
];

export function familiaDeNombre(texto) {
  if (typeof texto !== "string") return null;
  const t = sinAcentos(texto.toLowerCase());
  for (const [clave, familia] of NOMBRES) {
    if (new RegExp(`(^|[^a-z])${clave}([^a-z]|$)`).test(t)) return familia;
  }
  return null;
}

export function faltaColorMedible(item) {
  const meta = item?.metadata_ia || {};
  if (item?.tipo === "prenda") return !meta.color_medible;
  if (item?.tipo === "outfit") {
    return Array.isArray(meta.prendas) && meta.prendas.some((p) => !p?.color_medible);
  }
  return false;
}
