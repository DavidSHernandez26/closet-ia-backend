import { test } from "node:test";
import assert from "node:assert/strict";
import { esUuid } from "../lib/validar.js";

test("esUuid", () => {
  assert.equal(esUuid("3f2b8c1e-9a4d-4e2b-8f1a-2c3d4e5f6a7b"), true);
  assert.equal(esUuid("x),id.not.is.null,and(id.eq.x"), false);
  assert.equal(esUuid(undefined), false);
  assert.equal(esUuid(123), false);
});
