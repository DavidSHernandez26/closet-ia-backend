import { test } from "node:test";
import assert from "node:assert/strict";
import { elegirTanda, LOTE_REANALISIS } from "../lib/tanda.js";

test("100 pendientes -> 40, con los de color primero", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ i, color: i >= 70 }));
  const r = elegirTanda(items, (p) => p.color);
  assert.equal(LOTE_REANALISIS, 40);
  assert.equal(r.length, 40);
  assert.equal(r.slice(0, 30).every((p) => p.color), true);
  assert.equal(r.slice(30).every((p) => !p.color), true);
});

test("menos que el tope devuelve todo", () => {
  assert.equal(elegirTanda([{}, {}], () => false).length, 2);
});
