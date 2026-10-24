import { test } from "node:test";
import assert from "node:assert/strict";
import { fechaHoy, restarDias, calcularRacha } from "../lib/fechas.js";

test("fechaHoy: 04:30 UTC es todavía el día anterior en Bogotá", () => {
  assert.equal(fechaHoy(new Date("2026-10-25T04:30:00Z"), "America/Bogota"), "2026-10-24");
});
test("restarDias cruza meses", () => {
  assert.equal(restarDias("2026-03-01", 1), "2026-02-28");
});
test("calcularRacha: consecutiva terminando hoy", () => {
  assert.deepEqual(calcularRacha(["2026-10-24", "2026-10-23", "2026-10-23", "2026-10-22T10:00:00"], "2026-10-24"),
    { racha: 3, ultimaFecha: "2026-10-24", registroHoy: true });
});
test("calcularRacha: terminando ayer sigue viva, sin registro hoy", () => {
  assert.deepEqual(calcularRacha(["2026-10-23", "2026-10-22"], "2026-10-24"),
    { racha: 2, ultimaFecha: "2026-10-23", registroHoy: false });
});
test("calcularRacha: hueco la corta y vacío da 0", () => {
  assert.equal(calcularRacha(["2026-10-24", "2026-10-21"], "2026-10-24").racha, 1);
  assert.equal(calcularRacha(["2026-10-20"], "2026-10-24").racha, 0);
  assert.deepEqual(calcularRacha([], "2026-10-24"), { racha: 0, ultimaFecha: null, registroHoy: false });
});
