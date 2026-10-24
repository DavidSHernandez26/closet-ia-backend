import sharp from "sharp";

const NIVEL = 32; // tamaño del cubo por canal
const ALFA_MIN = 128;
const TRANSPARENTE_MIN = 0.05;

// Hex del color más frecuente entre píxeles opacos; null si la imagen tiene fondo.
export async function colorDominante(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .resize(64, 64, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  const cubos = new Map();
  let transparentes = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (data[o + 3] < ALFA_MIN) { transparentes++; continue; }
    const k = ((data[o] / NIVEL) | 0) * 64 + ((data[o + 1] / NIVEL) | 0) * 8 + ((data[o + 2] / NIVEL) | 0);
    const c = cubos.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    c.n++; c.r += data[o]; c.g += data[o + 1]; c.b += data[o + 2];
    cubos.set(k, c);
  }
  if (transparentes / total < TRANSPARENTE_MIN || cubos.size === 0) return null;
  const mejor = [...cubos.values()].sort((a, b) => b.n - a.n)[0];
  const hex = [mejor.r, mejor.g, mejor.b]
    .map((v) => Math.round(v / mejor.n).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`.toUpperCase();
}
