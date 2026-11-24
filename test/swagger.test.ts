import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { memoryStore } from "../src/store.js";

test("swagger descreve a API e entrega a interface", async () => {
  const deps = {
    config: loadConfig({ SESSION_SECRET: "teste", PUBLIC_API_URL: "https://api.invente.ai" }),
    store: memoryStore(),
    mailer: { async send() {} },
    now: () => new Date(),
    enqueue: async () => "skipped" as const,
    runPod: async () => ({ bytes: Buffer.from("x"), contentType: "image/png" }),
    saveMedia: async () => {},
    exchangeGoogleCode: async () => ({ sub: "s", email: "a@invente.ai" }),
  };
  const spec = await handle(get("/openapi.json"), deps);
  const body = spec.body as { openapi: string; paths: Record<string, unknown> };
  assert.equal(spec.status, 200);
  assert.equal(body.openapi, "3.0.3");
  assert.ok(body.paths["/v1/jobs"]);
  assert.ok(body.paths["/v1/generate"]);
  assert.ok(body.paths["/v1/auth/register"]);
  const page = await handle(get("/docs"), deps);
  assert.equal(page.status, 200);
  assert.match(page.raw || "", /swagger-ui/);
  const css = await handle(get("/docs/swagger-ui.css"), deps);
  assert.equal(css.status, 200);
  assert.match(css.raw || "", /swagger-ui/);
});

function get(path: string) {
  return { method: "GET", path, query: new URLSearchParams(), headers: {}, body: undefined, cookies: {} };
}
