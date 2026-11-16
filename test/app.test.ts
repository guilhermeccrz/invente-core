import assert from "node:assert/strict";
import test from "node:test";
import { handle, type Deps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Mail } from "../src/email/notify.js";
import { memoryStore } from "../src/store.js";

const now = new Date("2026-11-16T00:00:00.000Z");

export function makeDeps(patch: Partial<Deps> = {}): Deps & { sent: Mail[]; queued: string[]; saved: string[] } {
  const sent: Mail[] = [];
  const queued: string[] = [];
  const saved: string[] = [];
  const deps: Deps & { sent: Mail[]; queued: string[]; saved: string[] } = {
    config: loadConfig({
      ROLE: "api",
      SESSION_SECRET: "teste-sessao-secreta",
      PUBLIC_API_URL: "https://api.invente.ai",
      PUBLIC_APP_URL: "https://invente.ai",
      MEDIA_PREFIX: "invente.ai/",
      TASKS_QUEUE: "inventa-jobs",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "Invente <nao-responda@invente.ai>",
    }),
    store: memoryStore(),
    mailer: {
      async send(mail) {
        sent.push(mail);
      },
    },
    now: () => now,
    enqueue: async (jobId) => {
      queued.push(jobId);
      return "sent";
    },
    runPod: async () => ({ bytes: Buffer.from("png"), contentType: "image/png" }),
    saveMedia: async (name) => {
      saved.push(name);
    },
    exchangeGoogleCode: async () => ({ sub: "google-sub", email: "ana@invente.ai" }),
    sent,
    queued,
    saved,
    ...patch,
  };
  return deps;
}

export function cookieOf(header: string | undefined): string {
  const match = header?.match(/invente_session=([^;]+)/);
  return match?.[1] || "";
}

test("cadastro manda e-mail pelo mailer e login exige confirmacao", async () => {
  const deps = makeDeps();
  const created = await handle(post("/v1/auth/register", { email: "Ana@Invente.ai", password: "senha-forte" }), deps);
  assert.equal(created.status, 201);
  assert.equal(deps.sent.length, 1);
  assert.equal(deps.sent[0].to, "ana@invente.ai");
  assert.match(deps.sent[0].subject, /invente\.ai/);
  const token = deps.sent[0].text.match(/token=([^&\s]+)/)?.[1] || "";
  const denied = await handle(post("/v1/auth/login", { email: "ana@invente.ai", password: "senha-forte" }), deps);
  assert.equal(denied.status, 403);
  const verified = await handle(post("/v1/auth/verify", { token }), deps);
  assert.equal(verified.status, 200);
  const logged = await handle(post("/v1/auth/login", { email: "ana@invente.ai", password: "senha-forte" }), deps);
  assert.equal(logged.status, 200);
  const me = await handle(
    { method: "GET", path: "/v1/me", query: new URLSearchParams(), headers: {}, body: undefined, cookies: { invente_session: cookieOf(logged.headers["set-cookie"]) } },
    deps,
  );
  assert.equal(me.status, 200);
});

test("sem Resend o cadastro nao grava usuario", async () => {
  const deps = makeDeps();
  deps.mailer = {
    async send() {
      const { EmailNotConfigured } = await import("../src/email/notify.js");
      throw new EmailNotConfigured();
    },
  };
  const response = await handle(post("/v1/auth/register", { email: "ana@invente.ai", password: "senha-forte" }), deps);
  assert.equal(response.status, 503);
  assert.equal(await deps.store.findUserByEmail("ana@invente.ai"), null);
});

test("esqueci a senha nao revela conta inexistente", async () => {
  const deps = makeDeps();
  const missing = await handle(post("/v1/auth/forgot", { email: "ninguem@invente.ai" }), deps);
  assert.equal(missing.status, 202);
  assert.equal(deps.sent.length, 0);
});

test("job fica na fila e o worker grava so em invente.ai", async () => {
  const deps = makeDeps();
  await handle(post("/v1/auth/register", { email: "ana@invente.ai", password: "senha-forte" }), deps);
  const token = deps.sent[0].text.match(/token=([^&\s]+)/)?.[1] || "";
  await handle(post("/v1/auth/verify", { token }), deps);
  const logged = await handle(post("/v1/auth/login", { email: "ana@invente.ai", password: "senha-forte" }), deps);
  const cookies = { invente_session: cookieOf(logged.headers["set-cookie"]) };
  const job = await handle({ ...post("/v1/jobs", { prompt: "um gato" }), cookies }, deps);
  assert.equal(job.status, 202);
  assert.equal(deps.queued.length, 1);
  const body = job.body as { id: string };
  deps.config = { ...deps.config, role: "worker" };
  const done = await handle(
    {
      method: "POST",
      path: "/v1/tasks/jobs",
      query: new URLSearchParams(),
      headers: { "x-cloudtasks-queuename": "inventa-jobs" },
      body: { jobId: body.id },
      cookies: {},
    },
    deps,
  );
  assert.equal(done.status, 200);
  assert.match(deps.saved[0], /^invente\.ai\/users\/.+\/assets\/.+\.png$/);
  assert.equal(deps.sent.at(-1)?.subject.includes("pronta"), true);
});

test("worker sem pod nao tenta de novo", async () => {
  const deps = makeDeps({
    runPod: async () => {
      throw new Error("pod_not_configured");
    },
  });
  deps.config = { ...deps.config, role: "worker" };
  const userId = "abc12345abc12345";
  await deps.store.saveUser({
    id: userId,
    email: "ana@invente.ai",
    password_hash: null,
    google_sub: null,
    email_verified: true,
    created_at: now.toISOString(),
  });
  await deps.store.saveJob({
    id: "job12345job12345",
    user_id: userId,
    status: "queued",
    created_at: now.toISOString(),
    prompt: "um gato",
    workflow: "zimage_t2i",
    pod_id: null,
    asset_id: null,
    error: null,
  });
  const response = await handle(
    {
      method: "POST",
      path: "/v1/tasks/jobs",
      query: new URLSearchParams(),
      headers: { "x-cloudtasks-queuename": "inventa-jobs" },
      body: { jobId: "job12345job12345" },
      cookies: {},
    },
    deps,
  );
  assert.equal(response.status, 200);
  assert.equal((await deps.store.findJob("job12345job12345"))?.error, "pod_not_configured");
});

test("api publica nao executa task", async () => {
  const deps = makeDeps();
  const response = await handle(
    {
      method: "POST",
      path: "/v1/tasks/jobs",
      query: new URLSearchParams(),
      headers: { "x-cloudtasks-queuename": "inventa-jobs" },
      body: { jobId: "x" },
      cookies: {},
    },
    deps,
  );
  assert.equal(response.status, 404);
});

function post(path: string, body: unknown) {
  return { method: "POST", path, query: new URLSearchParams(), headers: {}, body, cookies: {} };
}
