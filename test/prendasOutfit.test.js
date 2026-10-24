import { test } from "node:test";
import assert from "node:assert/strict";
import { fusionarPrendasOutfit } from "../lib/prendasOutfit.js";

test("mismo largo: fusiona por índice y conserva color_medible previo", () => {
  const prev = { hex: "#000000", h: 0, s: 0, l: 0, familia: "negro", neutro: true };
  const r = fusionarPrendasOutfit(
    [{ nombre: "a", color: "x", tipo: "calzado", color_medible: prev }, { nombre: "b", color: "y", tipo: "abrigo" }],
    [{ nombre: "a2", color: "x2", tipo: "calzado" }, { nombre: "b2", color: "y2", tipo: "abrigo", color_hex: "#FF0000" }],
  );
  assert.equal(r[0].nombre, "a2");
  assert.deepEqual(r[0].color_medible, prev);
  assert.equal(r[1].color_medible.familia, "rojo");
});

test("distinto largo: reemplaza; hex inválido no guarda color_medible", () => {
  const r = fusionarPrendasOutfit(
    [{ nombre: "a", color_medible: { familia: "rojo" } }],
    [{ nombre: "n1", color: "c", tipo: "t", color_hex: "zzz" }, { nombre: "n2", color: "c", tipo: "t", color_hex: "#0000FF" }],
  );
  assert.equal(r.length, 2);
  assert.equal(r[0].color_medible, undefined);
  assert.equal(r[1].color_medible.familia, "azul");
});

test("nuevas vacío o inválido devuelve null", () => {
  assert.equal(fusionarPrendasOutfit([{}], []), null);
  assert.equal(fusionarPrendasOutfit([{}], null), null);
});
