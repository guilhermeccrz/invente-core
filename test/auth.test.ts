import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/password.js";
import { readSession, signSession } from "../src/session.js";

test("senha confere e senha errada nao", async () => {
  const hash = await hashPassword("senha-forte");
  assert.equal(await verifyPassword("senha-forte", hash), true);
  assert.equal(await verifyPassword("outra-senha", hash), false);
});

test("sessao assinada expira", () => {
  const secret = "teste";
  const token = signSession({ sid: "abc", exp: 2_000 }, secret);
  assert.equal(readSession(token, secret, 1_000)?.sid, "abc");
  assert.equal(readSession(token, secret, 3_000), null);
  assert.equal(readSession(token, "outra", 1_000), null);
});
