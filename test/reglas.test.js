import test from "node:test";
import assert from "node:assert/strict";
import { colorMedible } from "../lib/color.js";
import {
  REGLAS, NOMBRE_REGLA, colorDe, cuentaParaRegla, cumpleRegla, detectarRegla,
} from "../lib/reglas.js";

const p = (tipo, hex) => ({
  descripcion: `x (c) - ${tipo}`,
  metadata_ia: { color_medible: colorMedible(hex) },
});

test("constantes", () => {
  assert.equal(REGLAS.length, 6);
  assert.equal(NOMBRE_REGLA.triada, "Tríada");
  assert.equal(NOMBRE_REGLA.neutros_acento, "Neutros + acento");
  assert.equal(NOMBRE_REGLA.monocromatico, "Monocromático");
});

test("colorDe lee metadata_ia o color_medible directo", () => {
  const c = colorMedible("#E02020");
  assert.deepEqual(colorDe({ color_medible: c }), c);
  assert.equal(colorDe({ descripcion: "x" }), null);
});

test("cuentaParaRegla", () => {
  assert.equal(cuentaParaRegla(p("calzado", "#6B3E1F")), false);
  assert.equal(cuentaParaRegla(p("calzado", "#000000")), false);
  assert.equal(cuentaParaRegla(p("calzado", "#E02020")), true);
  assert.equal(cuentaParaRegla(p("accesorio", "#C0C0C0")), false);
  assert.equal(cuentaParaRegla(p("parte superior", "#000000")), true);
  assert.equal(cuentaParaRegla({ descripcion: "x - calzado" }), false);
});

test("monocromatico azul", () => {
  const ps = [p("parte superior", "#1E50C8"), p("parte inferior", "#0A2F80"), p("calzado", "#000000"), p("accesorio", "#C0C0C0")];
  assert.equal(cumpleRegla(ps, "monocromatico", ["azul"]), true);
});
test("monocromatico azul con jean", () => {
  assert.equal(cumpleRegla([p("parte superior", "#1E50C8"), p("parte inferior", "#5B7FA6")], "monocromatico", ["azul"]), true);
});
test("monocromatico roto", () => {
  assert.equal(cumpleRegla([p("parte superior", "#E02020"), p("parte inferior", "#2E8B57")], "monocromatico"), false);
});
test("monocromatico todo negro sin familia pedida", () => {
  assert.equal(cumpleRegla([p("parte superior", "#000000"), p("parte inferior", "#000000")], "monocromatico"), true);
});
test("monocromatico vacio", () => {
  assert.equal(cumpleRegla([], "monocromatico"), false);
  assert.equal(cumpleRegla([p("calzado", "#000000")], "dos_colores"), false);
});
test("monocromatico pedido azul pero no hay azul", () => {
  assert.equal(cumpleRegla([p("parte superior", "#E02020"), p("parte inferior", "#E02020")], "monocromatico", ["azul"]), false);
});

test("dos colores blanco y negro", () => {
  const ps = [p("parte superior", "#FFFFFF"), p("parte inferior", "#000000"), p("calzado", "#6B3E1F")];
  assert.equal(cumpleRegla(ps, "dos_colores", ["blanco", "negro"]), true);
  assert.equal(cumpleRegla(ps, "dos_colores", ["blanco", "gris"]), false);
  assert.equal(cumpleRegla([...ps, p("accesorio", "#E02020")], "dos_colores", ["blanco", "negro"]), false);
});

test("analogos cruzando 0 grados", () => {
  assert.equal(cumpleRegla([p("parte superior", "#FF0040"), p("parte inferior", "#FF6A00")], "analogos"), true);
  });
test("analogos falla con arco amplio y con un solo no neutro", () => {
  assert.equal(cumpleRegla([p("parte superior", "#E02020"), p("parte inferior", "#2E8B57")], "analogos"), false);
  assert.equal(cumpleRegla([p("parte superior", "#E02020"), p("parte inferior", "#000000")], "analogos"), false);
});

test("complementarios", () => {
  assert.equal(cumpleRegla([p("parte superior", "#0057FF"), p("parte inferior", "#FF8C00")], "complementarios"), true);
  assert.equal(cumpleRegla([p("parte superior", "#0057FF"), p("parte inferior", "#0057FF")], "complementarios"), false);
});

test("triada", () => {
  const ps = [p("parte superior", "#FF0000"), p("parte inferior", "#00C800"), p("abrigo", "#0000FF")];
  assert.equal(cumpleRegla(ps, "triada"), true);
  assert.equal(cumpleRegla(ps.slice(0, 2), "triada"), false);
});

test("neutros + acento", () => {
  const ps = [p("parte superior", "#808080"), p("parte inferior", "#000000"), p("abrigo", "#E02020")];
  assert.equal(detectarRegla(ps), "neutros_acento");
});

test("prenda sin color no cuenta", () => {
  const ps = [p("parte superior", "#808080"), p("parte inferior", "#000000"), { descripcion: "y - parte inferior", metadata_ia: {} }, p("abrigo", "#E02020")];
  assert.equal(detectarRegla(ps), "neutros_acento");
  assert.equal(detectarRegla([]), null);
});
