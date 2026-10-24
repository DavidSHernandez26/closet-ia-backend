import { test } from "node:test";
import assert from "node:assert/strict";
import { rutaDesdeUrlPublica } from "../lib/storage.js";

test("rutaDesdeUrlPublica", () => {
  assert.equal(rutaDesdeUrlPublica("https://abc.supabase.co/storage/v1/object/public/prendas/posts/u_1.jpg"), "posts/u_1.jpg");
  assert.equal(rutaDesdeUrlPublica("https://abc.supabase.co/storage/v1/object/public/otro/x.jpg"), null);
  assert.equal(rutaDesdeUrlPublica(null), null);
});

test("rutaDesdeUrlPublica: decodifica y quita query", () => {
  assert.equal(rutaDesdeUrlPublica("https://a.co/storage/v1/object/public/prendas/a%20b.jpg?t=1"), "a b.jpg");
  assert.equal(rutaDesdeUrlPublica(undefined), null);
  assert.equal(rutaDesdeUrlPublica(42), null);
});
