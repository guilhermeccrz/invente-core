import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeObjectName, objectName } from "../src/mediaPath.js";

const user = "abc12345abc12345";
const asset = "def12345def12345";

test("objeto nasce debaixo de invente.ai", () => {
  const name = objectName("invente.ai/", user, asset);
  assert.equal(name, `invente.ai/users/${user}/assets/${asset}.png`);
});

test("recusa 1900 e commcor", () => {
  assert.throws(() => assertSafeObjectName("1900-backoffice/foto.png", "invente.ai/"));
  assert.throws(() => assertSafeObjectName("invente.ai/1900-backoffice/foto.png", "invente.ai/"), /reservado/);
  assert.throws(() => assertSafeObjectName("invente.ai/commcor-backoffice-titles/foto.png", "invente.ai/"), /reservado/);
  assert.throws(() => assertSafeObjectName("invente.ai/../1900-backoffice/foto.png", "invente.ai/"), /recusado/);
});
