import { test } from "node:test";
import assert from "node:assert/strict";
import { resolverOutfit, construirMensajeUsuario, limpiarHistorial, leerOpcion, resolverEleccion } from "../lib/fashion.js";
import { NOMBRE_REGLA } from "../lib/reglas.js";
import { FASHION_SYSTEM_PROMPT } from "../prompts/fashion.js";

const sueltas = [
  { id: 12, tipo: "prenda", descripcion: "camiseta (blanco) - parte superior", metadata_ia: {} },
  { id: 13, tipo: "prenda", descripcion: "jean (azul) - parte inferior", metadata_ia: {} },
];
const guardado = { id: 99, tipo: "outfit", descripcion: "Outfit casual", metadata_ia: { prendas: [] } };

test("resolverOutfit: matchea IDs aunque vengan como string", () => {
  const r = resolverOutfit({ outfit_ids: ["12", "13"], cambiar_panel: true }, sueltas, []);
  assert.deepEqual(r.outfit.map(p => p.id), [12, 13]);
});
test("resolverOutfit: outfit guardado tiene prioridad", () => {
  const r = resolverOutfit({ outfit_ids: [99] }, sueltas, [guardado]);
  assert.equal(r.outfit_guardado.id, 99);
  assert.deepEqual(r.outfit, []);
});
test("resolverOutfit: sin prendas sueltas no rompe", () => {
  const r = resolverOutfit({ outfit_ids: [1] }, [], [guardado]);
  assert.deepEqual(r.outfit, []);
  assert.equal(r.outfit_guardado, null);
});
test("resolverOutfit: parsed null da fallback y normaliza sugerencias", () => {
  assert.equal(resolverOutfit(null, sueltas, []).cambiar_panel, true);
  const r = resolverOutfit({ outfit_ids: [12], sugerencias: ["Más formal", {}, { text: "a", action: "swap", tipo: "calzado" }, { text: "b" }] }, sueltas, []);
  assert.deepEqual(r.sugerencias, [{ text: "Más formal", action: "chat" }, { text: "a", action: "swap", tipo: "calzado" }]);
});
test("construirMensajeUsuario: excluye IDs del calendario reciente", () => {
  const txt = construirMensajeUsuario({ perfil: null, clima: null, prendasSueltas: sueltas, outfitsGuardados: [],
    outfitIdsAnteriores: [], calendarioReciente: [{ fecha: "2026-10-23", metadata: { outfit_ids: [12] } }], historial: [], mensaje: "hola" });
  assert.match(txt, /EXCLUSIÓN OBLIGATORIA: Los IDs \[12\]/);
  assert.match(txt, /Mensaje del usuario: hola$/);
});
test("limpiarHistorial: descarta basura, limita a 10 y 1000 chars", () => {
  const h = [{ role: "user" }, { role: "user", text: 5 }, ...Array.from({ length: 15 }, () => ({ role: "user", text: "x".repeat(2000) }))];
  const r = limpiarHistorial(h);
  assert.equal(r.length, 10);
  assert.equal(r[0].text.length, 1000);
  assert.deepEqual(limpiarHistorial("no"), []);
});

import { limpiarClima, limpiarIdsAnteriores } from "../lib/fashion.js";

test("limpiarClima: no-objeto devuelve null", () => {
  assert.equal(limpiarClima("x"), null);
  assert.equal(limpiarClima(null), null);
  assert.equal(limpiarClima([1]), null);
});
test("limpiarClima: convierte números y trunca strings", () => {
  const r = limpiarClima({ temp: "20", feels: "18", wind: "5", rain_prob: "40", city: "a".repeat(500), label: "x".repeat(100) });
  assert.equal(r.temp, 20);
  assert.equal(r.feels, 18);
  assert.equal(r.wind, 5);
  assert.equal(r.rain_prob, 40);
  assert.equal(r.city.length, 60);
  assert.equal(r.label.length, 60);
});
test("limpiarClima: temp no numérica devuelve null; otros campos inválidos se descartan", () => {
  assert.equal(limpiarClima({ temp: "abc" }), null);
  const r = limpiarClima({ temp: 10, wind: "abc" });
  assert.equal("wind" in r, false);
});
test("limpiarIdsAnteriores: tope de 30, strings, máx 64 chars", () => {
  const ids = Array.from({ length: 100 }, (_, i) => i);
  const r = limpiarIdsAnteriores(ids);
  assert.equal(r.length, 30);
  assert.equal(typeof r[0], "string");
  assert.deepEqual(limpiarIdsAnteriores(["a", "b".repeat(65)]), ["a"]);
});

/* ---- Task 6: opciones y elección ---- */
const c1 = { ids: ["12", "13"], prendas: sueltas, regla: "monocromatico", puntaje: 5 };
const c2 = { ids: ["13"], prendas: [sueltas[1]], regla: "analogos", puntaje: 3 };
const base = { perfil: null, clima: null, prendasSueltas: sueltas, outfitsGuardados: [], outfitIdsAnteriores: [], calendarioReciente: [], historial: [], mensaje: "hola" };

test("leerOpcion: lee el número del JSON parcial", () => {
  assert.equal(leerOpcion('{"opcion": 3, "resp'), 3);
  assert.equal(leerOpcion('{"respuesta":"x'), null);
});
test("resolverEleccion: usa la opción elegida", () => {
  const r = resolverEleccion({ opcion: 2, cambiar_panel: false, sugerencias: ["a"] }, [c1, c2], sueltas, []);
  assert.deepEqual(r.outfit.map(p => p.id), [13]);
  assert.equal(r.regla, NOMBRE_REGLA.analogos);
  assert.equal(r.valida, true);
  assert.equal(r.cambiar_panel, false);
  assert.deepEqual(r.sugerencias, [{ text: "a", action: "chat" }]);
});
test("resolverEleccion: opción inválida o ausente cae a la primera con valida false", () => {
  for (const p of [{ opcion: 9 }, {}, { opcion: 0 }]) {
    const r = resolverEleccion(p, [c1, c2], sueltas, []);
    assert.deepEqual(r.outfit.map(x => x.id), [12, 13]);
    assert.equal(r.valida, false);
  }
  assert.equal(resolverEleccion({}, [c1], sueltas, []).valida, false);
  const n = resolverEleccion(null, [c1], sueltas, []);
  assert.equal(n.valida, false); assert.equal(n.cambiar_panel, true); assert.deepEqual(n.sugerencias, []);
});
test("resolverEleccion: candidato guardado devuelve outfit_guardado", () => {
  const cg = { ids: ["99"], prendas: [guardado], regla: "neutros_acento", puntaje: 0 };
  const r = resolverEleccion({ opcion: 1 }, [cg], sueltas, [guardado]);
  assert.equal(r.outfit_guardado.id, 99);
  assert.deepEqual(r.outfit, []);
});
test("resolverEleccion: sin candidatos delega en resolverOutfit", () => {
  const r = resolverEleccion({ outfit_ids: [12] }, [], sueltas, []);
  assert.deepEqual(r.outfit.map(p => p.id), [12]);
  assert.equal(r.regla, null);
  assert.equal(r.valida, true);
});
test("construirMensajeUsuario: bloque OPCIONES y AVISO_REGLA", () => {
  const t = construirMensajeUsuario({ ...base, candidatos: [c1], avisoRegla: "no alcanza" });
  assert.match(t, /OPCIONES \(elige una por número\):/);
  assert.match(t, /1\) \[Monocromático\]/);
  assert.match(t, /AVISO_REGLA: no alcanza/);
  const s = construirMensajeUsuario(base);
  assert.doesNotMatch(s, /OPCIONES/);
});
test("prompt: opcion antes de respuesta y sin 'TODOS los accesorios'", () => {
  assert.ok(FASHION_SYSTEM_PROMPT.includes('{"opcion":N,"regla":"<nombre visible>","respuesta"'));
  assert.ok(!FASHION_SYSTEM_PROMPT.includes("Incluye TODOS los accesorios"));
  assert.ok(FASHION_SYSTEM_PROMPT.includes("AVISO_REGLA"));
});
