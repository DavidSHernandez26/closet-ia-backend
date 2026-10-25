import test from "node:test";
import assert from "node:assert/strict";
import { colorMedible } from "../lib/color.js";
import { generarCandidatos, MAX_COMBINACIONES } from "../lib/generador.js";
import { prepararOpciones } from "../lib/opciones.js";

// Closet de 200 prendas con la misma forma que el benchmark de la revisión final.
const hexes = ["#1E3A8A", "#FFFFFF", "#111111", "#808080", "#D2B48C", "#C0392B", "#27AE60", "#F1C40F", "#8E44AD", "#E67E22", "#5B7DB1", "#1ABC9C", "#FF69B4", "#6B4423"];
const nombres = {
  "parte superior": ["camiseta", "camisa", "polo"], "parte inferior": ["jean", "pantalón"], calzado: ["tenis", "botas"],
  abrigo: ["chaqueta", "blazer"], accesorio: ["reloj", "gorra", "bolso", "collar", "cinturón", "lentes", "pulsera"], vestido: ["vestido"],
};
const counts = { "parte superior": 60, "parte inferior": 40, calzado: 20, abrigo: 25, accesorio: 40, vestido: 15 };
let n = 0;
const prendas = [];
for (const [tipo, k] of Object.entries(counts)) {
  for (let i = 0; i < k; i++) {
    const hex = hexes[(n * 7) % hexes.length];
    const nom = nombres[tipo][i % nombres[tipo].length];
    n++;
    prendas.push({ id: String(n), tipo: "prenda", descripcion: `${nom} (${hex}) - ${tipo}`, metadata_ia: { nombre: nom, tipo, color: hex, temporada: "todo el año", color_medible: colorMedible(hex) } });
  }
}
const outfits = Array.from({ length: 20 }, (_, i) => ({
  id: `o${i}`, tipo: "outfit",
  metadata_ia: { prendas: [
    { nombre: "camiseta", tipo: "parte superior", color_medible: colorMedible(hexes[i % 14]) },
    { nombre: "jean", tipo: "parte inferior", color_medible: colorMedible("#5B7DB1") },
  ] },
}));

const medir = (fn) => { const t = performance.now(); const r = fn(); return { r, ms: performance.now() - t }; };

test("rendimiento: MAX_COMBINACIONES es 3000", () => {
  assert.equal(MAX_COMBINACIONES, 3000);
});

test("rendimiento: 200 prendas, regla libre, < 150 ms", () => {
  generarCandidatos({ prendas, regla: null, clima: { feels: 15 } }); // calentamiento del JIT
  const { r, ms } = medir(() => generarCandidatos({ prendas, regla: null, clima: { feels: 15 } }));
  assert.ok(r.length > 0);
  assert.ok(ms < 150, `tardó ${ms.toFixed(0)} ms`);
});

test("rendimiento: prepararOpciones con reintento de variedad < 300 ms", () => {
  const cal = Array.from({ length: 10 }, (_, i) => ({
    fecha: `2026-10-${10 + i}`, metadata: { outfit_ids: [String(i + 1)], regla: ["dos_colores", "monocromatico"][i % 2] },
  }));
  const pedir = () => prepararOpciones({
    datos: { calendarioEstilo: cal, calendarioReciente: cal }, prendasSueltas: prendas, outfitsGuardados: outfits,
    peticion: { mensaje: "outfit para hoy", clima: { feels: 15 }, outfitIdsAnteriores: [] },
  });
  pedir();
  const { r, ms } = medir(pedir);
  assert.ok(r.candidatos.length > 0);
  assert.ok(ms < 300, `tardó ${ms.toFixed(0)} ms`);
});
