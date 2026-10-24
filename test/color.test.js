import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { hexAHsl, colorMedible, familiaDeNombre, faltaColorMedible } from "../lib/color.js";
import { colorDominante } from "../lib/colorImagen.js";

test("hexAHsl", () => {
  assert.deepEqual(hexAHsl("#ff0000"), { h: 0, s: 100, l: 50 });
  assert.equal(hexAHsl("nope"), null);
});
test("colorMedible: familias y neutros", () => {
  const f = (hex) => { const c = colorMedible(hex); return [c.familia, c.neutro]; };
  assert.deepEqual(f("#000000"), ["negro", true]);
  assert.deepEqual(f("#FFFFFF"), ["blanco", true]);
  assert.deepEqual(f("#808080"), ["gris", true]);
  assert.deepEqual(f("#D2B48C"), ["beige", true]);
  assert.deepEqual(f("#1B2A4A"), ["azul marino", true]);
  assert.deepEqual(f("#FF0000"), ["rojo", false]);
  assert.deepEqual(f("#0057FF"), ["azul", false]);
  assert.deepEqual(f("#2E8B57"), ["verde", false]);
  assert.deepEqual(f("#FFD700"), ["amarillo", false]);
  assert.deepEqual(f("#800080"), ["morado", false]);
  assert.deepEqual(f("#6B3E1F"), ["café", false]);
});
test("colorMedible: colores comunes de ropa", () => {
  const f = (hex) => { const c = colorMedible(hex); return [c.familia, c.neutro]; };
  assert.deepEqual(f("#5B7FA6"), ["denim", true]);
  assert.deepEqual(f("#C19A6B"), ["beige", true]);
  assert.deepEqual(f("#808000"), ["verde", false]);
  assert.deepEqual(f("#800020"), ["rojo", false]);
  assert.deepEqual(f("#E1AD01"), ["amarillo", false]);
  assert.deepEqual(f("#FFA500"), ["naranja", false]);
  assert.deepEqual(f("#FFC0CB"), ["rosa", false]);
  assert.deepEqual(f("#40E0D0"), ["turquesa", false]);
  assert.equal(colorMedible("nope"), null);
});
test("familiaDeNombre", () => {
  assert.equal(familiaDeNombre("Verde Oliva"), "verde");
  assert.equal(familiaDeNombre("mostaza"), "amarillo");
  assert.equal(familiaDeNombre("azul marino"), "azul marino");
  assert.equal(familiaDeNombre("camel"), "beige");
  assert.equal(familiaDeNombre("xyz"), null);
});
test("faltaColorMedible", () => {
  assert.equal(faltaColorMedible({ tipo: "prenda", metadata_ia: {} }), true);
  assert.equal(faltaColorMedible({ tipo: "prenda", metadata_ia: { color_medible: { familia: "rojo" } } }), false);
  assert.equal(faltaColorMedible({ tipo: "outfit", metadata_ia: { prendas: [{ color_medible: {} }, {}] } }), true);
});
test("colorDominante: prenda roja con fondo transparente", async () => {
  const roja = await sharp({ create: { width: 40, height: 40, channels: 4, background: "#ff0000ff" } }).png().toBuffer();
  const img = await sharp({ create: { width: 100, height: 100, channels: 4, background: "#00000000" } })
    .composite([{ input: roja, top: 30, left: 30 }]).png().toBuffer();
  assert.equal(colorMedible(await colorDominante(img)).familia, "rojo");
});
test("colorDominante: imagen sin transparencia devuelve null", async () => {
  const opaca = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#00ff00" } }).png().toBuffer();
  assert.equal(await colorDominante(opaca), null);
});
