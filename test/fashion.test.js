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
const c1 = { ids: sueltas.map(p => String(p.id)), prendas: sueltas, regla: "monocromatico", puntaje: 5 };
const c2 = { ids: [String(sueltas[1].id)], prendas: [sueltas[1]], regla: "analogos", puntaje: 3 };
const base = { perfil: null, clima: null, prendasSueltas: sueltas, outfitsGuardados: [], outfitIdsAnteriores: [], calendarioReciente: [], historial: [], mensaje: "hola" };

test("leerOpcion: lee el número del JSON parcial", () => {
  assert.equal(leerOpcion('{"opcion": 3, "resp'), 3);
  assert.equal(leerOpcion('{"respuesta":"x'), null);
  assert.equal(leerOpcion('{"opcion":"2","resp'), 2);
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
  for (const p of [{ opcion: 9 }, {}, { opcion: -1 }]) {
    const r = resolverEleccion(p, [c1, c2], sueltas, []);
    assert.deepEqual(r.outfit.map(x => x.id), [12, 13]);
    assert.equal(r.valida, false);
  }
  assert.equal(resolverEleccion({}, [c1], sueltas, []).valida, false);
  const n = resolverEleccion(null, [c1], sueltas, []);
  assert.equal(n.valida, false); assert.equal(n.cambiar_panel, true); assert.deepEqual(n.sugerencias, []);
});
test("resolverEleccion: candidato guardado devuelve outfit_guardado", () => {
  const cg = { ids: [String(guardado.id)], prendas: [guardado], regla: "neutros_acento", puntaje: 0 };
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
  assert.ok(FASHION_SYSTEM_PROMPT.includes('{"opcion":N,"respuesta"'));
  assert.ok(!FASHION_SYSTEM_PROMPT.includes("Incluye TODOS los accesorios"));
  assert.ok(FASHION_SYSTEM_PROMPT.includes("AVISO_REGLA"));
});
test("construirMensajeUsuario: EXCLUSIÓN OBLIGATORIA solo sin candidatos", () => {
  const prev = { ...base, outfitIdsAnteriores: ["12"] };
  assert.match(construirMensajeUsuario(prev), /EXCLUSIÓN OBLIGATORIA/);
  assert.doesNotMatch(construirMensajeUsuario({ ...prev, candidatos: [c1] }), /EXCLUSIÓN OBLIGATORIA/);
});

test("resolverEleccion: opcion 0 = ninguna sirve → prendas de outfit_ids con la regla detectada", async () => {
  const { colorMedible } = await import("../lib/color.js");
  const blanca = { id: 21, tipo: "prenda", descripcion: "camiseta blanca - parte superior", metadata_ia: { tipo: "parte superior", color_medible: colorMedible("#FFFFFF") } };
  const negro = { id: 22, tipo: "prenda", descripcion: "pantalón negro - parte inferior", metadata_ia: { tipo: "parte inferior", color_medible: colorMedible("#111111") } };
  const r = resolverEleccion({ opcion: 0, outfit_ids: [21, "22"], cambiar_panel: true }, [c1, c2], [...sueltas, blanca, negro], []);
  assert.deepEqual(r.outfit.map((x) => x.id), [21, 22]);
  assert.equal(r.valida, true);
  assert.equal(r.regla, NOMBRE_REGLA.dos_colores);
  assert.equal(r.cambiar_panel, true);
  assert.equal(leerOpcion('{"opcion":0,"respuesta":"'), 0);
});
test("prompt: permite opcion 0 cuando ninguna opción sirve", () => {
  assert.match(FASHION_SYSTEM_PROMPT, /"opcion":0/);
});
test("construirMensajeUsuario: marca (sin accesorio) / (sin calzado) en las opciones", () => {
  const zap = { id: 14, tipo: "prenda", descripcion: "tenis (negro) - calzado", metadata_ia: {} };
  const acc = { id: 15, tipo: "prenda", descripcion: "reloj (gris) - accesorio", metadata_ia: {} };
  const completo = { ids: ["12", "13", "14", "15"], prendas: [...sueltas, zap, acc], regla: "monocromatico" };
  const sinNada = { ids: ["12", "13"], prendas: sueltas, regla: "monocromatico" };
  const guardadoSinAcc = { ids: ["99"], regla: "dos_colores", prendas: [{ ...guardado, metadata_ia: { prendas: [{ nombre: "botas", tipo: "calzado" }] } }] };
  const t = construirMensajeUsuario({ ...base, candidatos: [completo, sinNada, guardadoSinAcc] });
  const lineas = t.split("\n").filter((l) => /^\d\) /.test(l));
  assert.doesNotMatch(lineas[0], /sin accesorio|sin calzado/);
  assert.match(lineas[1], /\(sin accesorio\)/);
  assert.match(lineas[1], /\(sin calzado\)/);
  assert.match(lineas[2], /\(sin accesorio\)/);
  assert.doesNotMatch(lineas[2], /sin calzado/);
});
test("prompt: pide mencionar (sin accesorio) / (sin calzado)", () => {
  assert.ok(FASHION_SYSTEM_PROMPT.includes("(sin accesorio)"));
  assert.ok(FASHION_SYSTEM_PROMPT.includes("(sin calzado)"));
});
