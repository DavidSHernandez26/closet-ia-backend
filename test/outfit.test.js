import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizarTipo, deduplicarPorTipo, safeParseJSON } from "../lib/outfit.js";

const p = (id, descripcion, metadata_ia = {}) => ({ id, descripcion, metadata_ia });

test("normalizarTipo: hoodie en parte superior cuenta como abrigo", () => {
  assert.equal(normalizarTipo("hoodie (gris) - parte superior"), "abrigo");
});
test("normalizarTipo: metadata_ia.tipo tiene prioridad", () => {
  assert.equal(normalizarTipo("x (negro) - accesorio", { tipo: "Calzado" }), "calzado");
});
test("deduplicarPorTipo: con vestido descarta superior e inferior", () => {
  const r = deduplicarPorTipo([p(1, "vestido (rojo) - vestido"), p(2, "camiseta (blanco) - parte superior"), p(3, "jean (azul) - parte inferior"), p(4, "tenis (blanco) - calzado")]);
  assert.deepEqual(r.map(x => x.id), [1, 4]);
});
test("deduplicarPorTipo: un accesorio por subtipo", () => {
  const r = deduplicarPorTipo([p(1, "gorra (negro) - accesorio"), p(2, "gorra (rojo) - accesorio"), p(3, "reloj (plata) - accesorio")]);
  assert.deepEqual(r.map(x => x.id), [1, 3]);
});
test("safeParseJSON: extrae JSON rodeado de texto y devuelve null si no hay", () => {
  assert.deepEqual(safeParseJSON('ok {"a":1} fin'), { a: 1 });
  assert.equal(safeParseJSON("sin json"), null);
});
