import test from "node:test";
import assert from "node:assert/strict";
import { colorMedible } from "../lib/color.js";
import { aprenderEstilo, puntuarCandidato, PENALIZACION_RECIENTE } from "../lib/estilo.js";

let n = 0;
const prenda = (tipo, hex) => ({
  id: ++n,
  tipo: "prenda",
  descripcion: `x (x) - ${tipo}`,
  metadata_ia: { nombre: "x", tipo, color_medible: colorMedible(hex) },
});

const azul1 = prenda("parte superior", "#1E50C8");
const azul2 = prenda("parte inferior", "#6A9AF0");
const rojo = prenda("parte superior", "#E02020");
const naranja = prenda("parte inferior", "#E07020");
const zap = prenda("calzado", "#000000");
const prendasSueltas = [azul1, azul2, rojo, naranja, zap];

const entrada = (fecha, ...ps) => ({ fecha, metadata: { outfit_ids: ps.map((p) => p.id) } });
const calendario = [
  entrada("2026-10-01", azul1, azul2, zap),
  entrada("2026-10-02", azul1, azul2),
  entrada("2026-10-03", azul1, azul2, zap),
  entrada("2026-10-04", rojo, naranja, zap),
];

test("aprenderEstilo: 3 monocromáticos y 1 análogo", () => {
  const e = aprenderEstilo({ calendario, prendasSueltas, outfitsGuardados: [] });
  assert.equal(e.reglas.monocromatico, 0.75);
  assert.equal(e.reglas.analogos, 0.25);
  const sumaF = Object.values(e.familias).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumaF - 1) < 1e-9);
  assert.ok(e.familias.azul > e.familias.rojo);
});

test("aprenderEstilo: incluye outfits guardados y tolera vacíos", () => {
  const pz = (tipo, hex) => ({ nombre: "x", tipo, color_medible: colorMedible(hex) });
  const guardado = { id: 77, tipo: "outfit", metadata_ia: { prendas: [pz("parte superior", "#E02020"), pz("parte inferior", "#E07020")] } };
  const e = aprenderEstilo({ calendario: [], prendasSueltas: [], outfitsGuardados: [guardado] });
  assert.equal(e.reglas.analogos, 1);
  assert.deepEqual(aprenderEstilo({}), { reglas: {}, familias: {} });
  // un id del calendario que es un outfit guardado se expande a sus prendas
  const e2 = aprenderEstilo({ calendario: [{ fecha: "x", metadata: { outfit_ids: [77] } }], prendasSueltas: [], outfitsGuardados: [guardado] });
  assert.equal(e2.reglas.analogos, 1);
});

test("puntuarCandidato: monocromático > análogo con ese estilo", () => {
  const e = aprenderEstilo({ calendario, prendasSueltas, outfitsGuardados: [] });
  const mono = { ids: [String(azul1.id), String(azul2.id)], prendas: [azul1, azul2], regla: "monocromatico", puntaje: 0 };
  const ana = { ids: [String(rojo.id), String(naranja.id)], prendas: [rojo, naranja], regla: "analogos", puntaje: 0 };
  assert.ok(puntuarCandidato(mono, e, []) > puntuarCandidato(ana, e, []));
});

test("puntuarCandidato: prenda reciente resta", () => {
  const e = aprenderEstilo({ calendario, prendasSueltas, outfitsGuardados: [] });
  const c = { ids: [String(azul1.id), String(azul2.id)], prendas: [azul1, azul2], regla: "monocromatico", puntaje: 0 };
  const sin = puntuarCandidato(c, e, []);
  const con = puntuarCandidato(c, e, [azul1.id]);
  assert.ok(con < sin);
  assert.ok(Math.abs(sin - con - PENALIZACION_RECIENTE) < 1e-9);
  assert.equal(puntuarCandidato(c, null, []), 0);
});

test("estiloSinOutfit: un outfit guardado no se puntúa con su propio aporte", async () => {
  const { contarEstilo, estiloSinOutfit } = await import("../lib/estilo.js");
  const pz = (tipo, hex) => ({ nombre: "x", tipo, color_medible: colorMedible(hex) });
  const o = { id: "o1", tipo: "outfit", metadata_ia: { prendas: [pz("parte superior", "#1E50C8"), pz("parte inferior", "#6A9AF0")] } };
  const cuentas = contarEstilo({ calendario: [], prendasSueltas, outfitsGuardados: [o] });
  assert.equal(cuentas.reglas.monocromatico, 1);
  assert.deepEqual(estiloSinOutfit(cuentas, o), { reglas: {}, familias: {} });
  const c = { ids: ["o1"], prendas: [o], regla: "monocromatico" };
  assert.equal(puntuarCandidato(c, estiloSinOutfit(cuentas, o)), 0);
  assert.ok(puntuarCandidato(c, aprenderEstilo({ outfitsGuardados: [o] })) > 0);
});
