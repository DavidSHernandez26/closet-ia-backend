import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretarPedido } from "../lib/pedidoColor.js";

const t = (m) => interpretarPedido(m);

test("reglas y familias", () => {
  assert.deepEqual(t("quiero algo monocromático en azul"), { regla: "monocromatico", familias: ["azul"], excluirTipos: [], editarTipo: null });
  assert.deepEqual(t("solo blanco y negro"), { regla: "dos_colores", familias: ["blanco", "negro"], excluirTipos: [], editarTipo: null });
  assert.equal(t("un look con 2 colores").regla, "dos_colores");
  assert.equal(t("algo con complementarios").regla, "complementarios");
  assert.equal(t("colores análogos porfa").regla, "analogos");
  assert.equal(t("una tríada").regla, "triada");
  assert.equal(t("todo neutro con un toque de color").regla, "neutros_acento");
  assert.deepEqual(t("outfit para hoy"), { regla: null, familias: [], excluirTipos: [], editarTipo: null });
});

test("exclusión y edición", () => {
  assert.deepEqual(t("sin la chaqueta negra"), { regla: null, familias: [], excluirTipos: ["abrigo"], editarTipo: null });
  assert.deepEqual(t("cambia solo los zapatos"), { regla: null, familias: [], excluirTipos: [], editarTipo: "calzado" });
  assert.deepEqual(t("cambia la camisa blanca"), { regla: null, familias: [], excluirTipos: [], editarTipo: "parte superior" });
});

test("extras", () => {
  assert.deepEqual(t("algo en azul marino").familias, ["azul marino"]);
  assert.deepEqual(t("azul y azul y negro").familias, ["azul", "negro"]);
  assert.deepEqual(t("no quiero las camisas").excluirTipos, ["parte superior"]);
  assert.deepEqual(t("quitale los jeans azules").excluirTipos, ["parte inferior"]);
  assert.deepEqual(t("quita la gorra").excluirTipos, ["accesorio"]);
  assert.deepEqual(t("todo verde sin sandalias").familias, ["verde"]);
  assert.deepEqual(t("jean con camisa blanca").familias, ["blanco"]);
});
