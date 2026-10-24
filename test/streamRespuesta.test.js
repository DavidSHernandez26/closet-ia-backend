import { test } from "node:test";
import assert from "node:assert/strict";
import { crearExtractorRespuesta } from "../lib/streamRespuesta.js";

const correr = (piezas) => { const ex = crearExtractorRespuesta(); return { texto: piezas.map(p => ex.push(p)).join(""), ex }; };

test("extrae solo el campo respuesta", () => {
  const { texto, ex } = correr(['{"respu', 'esta":"Hola ', 'mundo","outfit_ids":[1]}']);
  assert.equal(texto, "Hola mundo");
  assert.equal(ex.terminado, true);
});
test("escapes partidos entre chunks", () => {
  assert.equal(correr(['{"respuesta":"a\\', 'nb \\"c\\', '""}']).texto, 'a\nb "c"');
});
test("unicode escapes, también partidos", () => {
  assert.equal(correr(['{"respuesta":"est\\u00e1 ', 'bien \\u00', 'e9"}']).texto, "está bien é");
});
