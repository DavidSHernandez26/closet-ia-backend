import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretarPedido } from "../lib/pedidoColor.js";

const t = (m) => interpretarPedido(m);

test("reglas y familias", () => {
  assert.deepEqual(t("quiero algo monocromático en azul"), { regla: "monocromatico", familias: ["azul"], excluirFamilias: [], excluirTipos: [], editarTipo: null });
  assert.deepEqual(t("solo blanco y negro"), { regla: "dos_colores", familias: ["blanco", "negro"], excluirFamilias: [], excluirTipos: [], editarTipo: null });
  assert.equal(t("un look con 2 colores").regla, "dos_colores");
  assert.equal(t("algo con complementarios").regla, "complementarios");
  assert.equal(t("colores análogos porfa").regla, "analogos");
  assert.equal(t("una tríada").regla, "triada");
  assert.equal(t("todo neutro con un toque de color").regla, "neutros_acento");
  assert.deepEqual(t("outfit para hoy"), { regla: null, familias: [], excluirFamilias: [], excluirTipos: [], editarTipo: null });
});

test("exclusión y edición", () => {
  assert.deepEqual(t("sin la chaqueta negra"), { regla: null, familias: [], excluirFamilias: [], excluirTipos: ["abrigo"], editarTipo: null });
  assert.deepEqual(t("cambia solo los zapatos"), { regla: null, familias: [], excluirFamilias: [], excluirTipos: [], editarTipo: "calzado" });
  assert.deepEqual(t("cambia la camisa blanca"), { regla: null, familias: [], excluirFamilias: [], excluirTipos: [], editarTipo: "parte superior" });
});

test("extras", () => {
  assert.deepEqual(t("algo en azul marino").familias, ["azul marino"]);
  assert.deepEqual(t("azul y azul y negro").familias, ["azul", "negro"]);
  assert.deepEqual(t("no quiero las camisas").excluirTipos, ["parte superior"]);
  assert.deepEqual(t("quitale los jeans azules").excluirTipos, ["parte inferior"]);
  assert.deepEqual(t("quita la gorra").excluirTipos, ["accesorio"]);
  assert.deepEqual(t("todo verde sin sandalias").familias, ["verde"]);
  });

const r = (m) => { const x = t(m); return [x.regla, x.familias, x.excluirFamilias, x.excluirTipos, x.editarTipo]; };

test("colores negados", () => {
  assert.deepEqual(r("no quiero nada rojo"), [null, [], ["rojo"], [], null]);
  assert.deepEqual(r("sin negro hoy"), [null, [], ["negro"], [], null]);
  assert.deepEqual(r("no me gusta el rojo"), [null, [], ["rojo"], [], null]);
  assert.deepEqual(r("evita el rojo"), [null, [], ["rojo"], [], null]);
  assert.deepEqual(r("sin nada de rojo".replace(" de", "")), [null, [], ["rojo"], [], null]);
  assert.deepEqual(r("quiero algo en azul pero sin azul marino"), [null, ["azul"], ["azul marino"], [], null]);
});

test("colores de prendas mencionadas", () => {
  assert.deepEqual(r("tengo una camisa azul"), [null, [], [], [], null]);
  assert.deepEqual(r("outfit con mi jean y una camisa blanca"), [null, [], [], [], null]);
  assert.deepEqual(r("qué combina con mi chaqueta verde?"), [null, [], [], [], null]);
  assert.deepEqual(r("camisa azul y pantalon blanco"), [null, [], [], [], null]);
});

test("regla inferida de colores", () => {
  assert.deepEqual(r("solo rojo"), ["monocromatico", ["rojo"], [], [], null]);
  assert.deepEqual(r("todo negro"), ["monocromatico", ["negro"], [], [], null]);
  assert.deepEqual(r("un look azul y blanco"), ["dos_colores", ["azul", "blanco"], [], [], null]);
  assert.deepEqual(r("dame algo rojo"), [null, ["rojo"], [], [], null]);
});

test("variantes quita/cambia", () => {
  assert.deepEqual(r("quita el abrigo"), [null, [], [], ["abrigo"], null]);
  assert.deepEqual(r("quitale la gorra negra"), [null, [], [], ["accesorio"], null]);
  assert.deepEqual(r("cambiame los zapatos"), [null, [], [], [], "calzado"]);
  assert.deepEqual(r("cambiale la camisa azul"), [null, [], [], [], "parte superior"]);
});
