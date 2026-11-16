import assert from "node:assert/strict";
import test from "node:test";
import { handle, type Deps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { signSession } from "../src/session.js";
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
    runPod: async () => ({
      bytes: Buffer.from("png"),
      contentType: "image/png",
      podPath: "/workspace/ComfyUI/output/z-image-turbo_00001_.png",
    }),
    readPodToken: async () => "token-de-teste",
    loadMedia: async () => Buffer.from("entrada"),
    signMedia: async (name) => `https://signed.example/${name}`,
    deleteMedia: async (name) => {
      saved.push(`del:${name}`);
    },
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
  const account = await deps.store.findUserByEmail("ana@invente.ai");
  if (account) {
    account.token_balance = 10000;
    await deps.store.saveUser(account);
  }
  await deps.store.savePod({
    id: "a6000-sp-1",
    name: "a6000-sp-1",
    enabled: true,
    base_url: "https://pod.example",
    token_secret: "inventa-pod-a6000-sp-1-token",
    max_concurrent: 1,
    workflows: ["zimage_t2i", "flux2_t2i", "qwen_image_2_1_t2i", "minimax_i2v", "wan_animate"],
    image_timeout_seconds: 480,
    video_timeout_seconds: 900,
  });
  const job = await handle({ ...post("/v1/jobs", { prompt: "um gato" }), cookies }, deps);
  assert.equal(job.status, 202);
  assert.equal((job.body as { poll_after_ms: number }).poll_after_ms, 4000);
  assert.equal(deps.queued.length, 1);
  const body = job.body as { jobs: { id: string; progress: number; stage: string }[] };
  assert.equal(body.jobs[0].stage, "queued");
  assert.equal(body.jobs[0].progress, 0);
  deps.config = { ...deps.config, role: "worker" };
  const done = await handle(
    {
      method: "POST",
      path: "/v1/tasks/jobs",
      query: new URLSearchParams(),
      headers: { "x-cloudtasks-queuename": "inventa-jobs" },
      body: { jobId: body.jobs[0].id },
      cookies: {},
    },
    deps,
  );
  assert.equal(done.status, 200);
  assert.match(deps.saved[0], /^invente\.ai\/users\/.+\/images\/.+\.png$/);
  const stored = await deps.store.findJob(body.jobs[0].id);
  assert.equal(stored?.status, "done");
  assert.equal(stored?.progress, 100);
  assert.equal(stored?.pod_path, "/workspace/ComfyUI/output/z-image-turbo_00001_.png");
  const viewed = await handle(
    { method: "GET", path: `/v1/jobs/${body.jobs[0].id}`, query: new URLSearchParams(), headers: {}, body: undefined, cookies },
    deps,
  );
  const view = viewed.body as { result_url?: string; progress: number; stage_label: string };
  assert.equal(view.progress, 100);
  assert.equal(view.stage_label, "Pronto");
  assert.match(view.result_url || "", /^https:\/\/signed\.example\/invente\.ai\/users\/.+\/images\//);
  assert.equal(deps.sent.at(-1)?.subject.includes("pronta"), true);
  assert.match(deps.sent.at(-1)?.html || "", /invente\.ai/);
  const gallery = await handle(
    { method: "GET", path: "/v1/gallery", query: new URLSearchParams("kind=image"), headers: {}, body: undefined, cookies },
    deps,
  );
  const galleryBody = gallery.body as { items: { id: string; result_url?: string }[] };
  assert.equal(galleryBody.items.length, 1);
  assert.match(galleryBody.items[0].result_url || "", /signed\.example/);
  const removed = await handle(
    { method: "DELETE", path: `/v1/gallery/${galleryBody.items[0].id}`, query: new URLSearchParams(), headers: {}, body: undefined, cookies },
    deps,
  );
  assert.equal(removed.status, 204);
  assert.equal((await deps.store.listAssets(account?.id || "")).length, 0);
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
    token_balance: 10,
  });
  await deps.store.saveJob({
    id: "job12345job12345",
    user_id: userId,
    status: "queued",
    stage: "queued",
    progress: 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    started_at: null,
    timeout_seconds: 480,
    prompt: "um gato",
    workflow: "zimage_t2i",
    kind: "image",
    seed: 1,
    image_asset_id: null,
    video_asset_id: null,
    pod_id: null,
    asset_id: null,
    error: null,
    pod_path: null,
    mode: "manual",
    token_cost: 10,
    tokens_state: "held",
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
  assert.equal((await deps.store.findJob("job12345job12345"))?.tokens_state, "refunded");
  assert.equal((await deps.store.findUserById(userId))?.token_balance, 20);
});

test("modo auto cobra a media e saldo curto nao entra na fila", async () => {
  const deps = makeDeps();
  const userId = "abc12345abc12345";
  await deps.store.saveUser({
    id: userId,
    email: "ana@invente.ai",
    password_hash: null,
    google_sub: null,
    email_verified: true,
    created_at: now.toISOString(),
    token_balance: 23,
  });
  await deps.store.savePod({
    id: "a6000-sp-1",
    name: "a6000-sp-1",
    enabled: true,
    base_url: "https://pod.example",
    token_secret: "inventa-pod-a6000-sp-1-token",
    max_concurrent: 1,
    workflows: ["zimage_t2i", "qwen_image_2_1_t2i", "minimax_i2v"],
    image_timeout_seconds: 480,
    video_timeout_seconds: 900,
  });
  await deps.store.saveSession({ id: "sess1234sess1234", user_id: userId, expires_at: "2027-01-01T00:00:00.000Z" });
  const cookies = { invente_session: signSession({ sid: "sess1234sess1234", exp: Date.parse("2027-01-01T00:00:00.000Z") }, "teste-sessao-secreta") };
  const created = await handle({ ...post("/v1/generate", { items: [{ workflow: "image_auto", prompt: "um gato" }] }), cookies }, deps);
  assert.equal(created.status, 202);
  const body = created.body as { jobs: { workflow: string; token_cost: number; mode: string }[]; token_balance: number };
  assert.equal(body.jobs[0].mode, "auto");
  assert.equal(body.jobs[0].workflow, "qwen_image_2_1_t2i");
  assert.equal(body.jobs[0].token_cost, 23);
  assert.equal(body.token_balance, 0);
  const denied = await handle({ ...post("/v1/generate", { items: [{ workflow: "video_auto", prompt: "um gato" }] }), cookies }, deps);
  assert.equal(denied.status, 402);
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
