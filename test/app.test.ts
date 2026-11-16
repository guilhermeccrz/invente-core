import assert from "node:assert/strict";
import test from "node:test";
import { handle, type Deps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { resolveChoice } from "../src/pricing.js";
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
  const kept = await deps.store.listAssets(account?.id || "");
  assert.equal(kept.length, 1);
  assert.ok(kept[0].deleted_at);
  const after = await handle(
    { method: "GET", path: "/v1/gallery", query: new URLSearchParams("kind=image"), headers: {}, body: undefined, cookies },
    deps,
  );
  assert.equal((after.body as { items: unknown[] }).items.length, 0);
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
  const imageAuto = resolveChoice("image_auto")?.tokens || 0;
  const imageRun = resolveChoice("image_auto")?.workflow;
  const userId = "abc12345abc12345";
  await deps.store.saveUser({
    id: userId,
    email: "ana@invente.ai",
    password_hash: null,
    google_sub: null,
    email_verified: true,
    created_at: now.toISOString(),
    token_balance: imageAuto,
  });
  await deps.store.savePod({
    id: "a6000-sp-1",
    name: "a6000-sp-1",
    enabled: true,
    base_url: "https://pod.example",
    token_secret: "inventa-pod-a6000-sp-1-token",
    max_concurrent: 1,
    workflows: ["zimage_t2i", "flux2_t2i", "qwen_image_2_1_t2i", "minimax_i2v"],
    image_timeout_seconds: 480,
    video_timeout_seconds: 900,
  });
  await deps.store.saveSession({ id: "sess1234sess1234", user_id: userId, expires_at: "2027-01-01T00:00:00.000Z" });
  const cookies = { invente_session: signSession({ sid: "sess1234sess1234", exp: Date.parse("2027-01-01T00:00:00.000Z") }, "teste-sessao-secreta") };
  const created = await handle({ ...post("/v1/generate", { items: [{ workflow: "image_auto", prompt: "um gato" }] }), cookies }, deps);
  assert.equal(created.status, 202);
  const body = created.body as { jobs: { workflow: string; token_cost: number; mode: string }[]; token_balance: number };
  assert.equal(body.jobs[0].mode, "auto");
  assert.equal(body.jobs[0].workflow, imageRun);
  assert.equal(body.jobs[0].token_cost, imageAuto);
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

test("referencia fica no bucket do usuario e so ele le", async () => {
  const deps = makeDeps();
  const files = new Map<string, Buffer>();
  deps.saveMedia = async (name, bytes) => {
    files.set(name, bytes);
  };
  deps.loadMedia = async (name) => files.get(name) || Buffer.alloc(0);
  await handle(post("/v1/auth/register", { email: "ana@invente.ai", password: "senha-forte" }), deps);
  const token = deps.sent[0].text.match(/token=([^&\s]+)/)?.[1] || "";
  await handle(post("/v1/auth/verify", { token }), deps);
  const logged = await handle(post("/v1/auth/login", { email: "ana@invente.ai", password: "senha-forte" }), deps);
  const cookies = { invente_session: cookieOf(logged.headers["set-cookie"]) };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const uploaded = await handle({
    ...post("/v1/assets", { kind: "image", content_type: "image/png", data_base64: png.toString("base64") }),
    cookies,
  }, deps);
  assert.equal(uploaded.status, 201);
  const body = uploaded.body as { id: string; media_path: string };
  const savedName = [...files.keys()][0] || "";
  assert.match(savedName, /^invente\.ai\/users\/[a-f0-9]{32}\/images\/[a-f0-9]{32}\.png$/);
  const media = await handle({ method: "GET", path: body.media_path, query: new URLSearchParams(), headers: {}, body: undefined, cookies }, deps);
  assert.equal(media.status, 200);
  assert.equal(Buffer.isBuffer(media.raw) ? media.raw.length : 0, png.length);
  const stranger = await handle({ method: "GET", path: body.media_path, query: new URLSearchParams(), headers: {}, body: undefined, cookies: {} }, deps);
  assert.equal(stranger.status, 401);
  const local = await handle({
    method: "POST",
    path: "/v1/auth/login",
    query: new URLSearchParams(),
    headers: { "x-forwarded-proto": "http" },
    body: { email: "ana@invente.ai", password: "senha-forte" },
    cookies: {},
  }, deps);
  assert.equal(local.headers["set-cookie"]?.includes("Secure"), false);
});

test("apagar vai para a lixeira e some depois de dois dias", async () => {
  const deps = makeDeps();
  const userId = "25401d1539b28658f2c9d228180006d6";
  await deps.store.saveUser({
    id: userId,
    email: "ana@invente.ai",
    password_hash: null,
    google_sub: null,
    email_verified: true,
    created_at: "2026-11-16T00:00:00.000Z",
    token_balance: 0,
  });
  await deps.store.saveSession({ id: "sess1234sess1234", user_id: userId, expires_at: "2027-01-01T00:00:00.000Z" });
  const cookies = { invente_session: signSession({ sid: "sess1234sess1234", exp: Date.parse("2027-01-01T00:00:00.000Z") }, "teste-sessao-secreta") };
  await deps.store.saveAsset({
    id: "asset1234asset1234",
    user_id: userId,
    created_at: "2026-11-16T00:00:00.000Z",
    object_name: "invente.ai/users/25401d1539b28658f2c9d228180006d6/images/asset1234asset1234.png",
    content_type: "image/png",
    job_id: "asset1234asset1234",
    kind: "image",
    workflow: "zimage_t2i",
    prompt: "um gato",
    mode: "manual",
  });
  const removed = await handle({ method: "DELETE", path: "/v1/gallery/asset1234asset1234", query: new URLSearchParams(), headers: {}, body: undefined, cookies }, deps);
  assert.equal(removed.status, 204);
  const visible = await handle({ method: "GET", path: "/v1/gallery", query: new URLSearchParams(), headers: {}, body: undefined, cookies }, deps);
  assert.equal((visible.body as { items: unknown[] }).items.length, 0);
  const trash = await handle({ method: "GET", path: "/v1/gallery", query: new URLSearchParams("trash=1"), headers: {}, body: undefined, cookies }, deps);
  assert.equal((trash.body as { items: { prompt: string }[] }).items[0].prompt, "um gato");
  deps.now = () => new Date("2026-11-19T00:00:00.000Z");
  const expired = await handle({ method: "GET", path: "/v1/gallery", query: new URLSearchParams("trash=1"), headers: {}, body: undefined, cookies }, deps);
  assert.equal((expired.body as { items: unknown[] }).items.length, 0);
  assert.equal(deps.saved.some((name) => name.startsWith("del:")), true);
});

test("cron da lixeira apaga so o que passou do prazo", async () => {
  const deps = makeDeps();
  deps.config = { ...deps.config, role: "worker" };
  await deps.store.saveAsset({
    id: "asset1234asset1234",
    user_id: "25401d1539b28658f2c9d228180006d6",
    created_at: "2026-11-01T00:00:00.000Z",
    deleted_at: "2026-11-10T00:00:00.000Z",
    object_name: "invente.ai/users/25401d1539b28658f2c9d228180006d6/images/asset1234asset1234.png",
    content_type: "image/png",
    job_id: "asset1234asset1234",
    kind: "image",
    workflow: "zimage_t2i",
    prompt: "um gato",
    mode: "manual",
  });
  const denied = await handle({
    method: "POST",
    path: "/v1/tasks/trash",
    query: new URLSearchParams(),
    headers: {},
    body: undefined,
    cookies: {},
  }, deps);
  assert.equal(denied.status, 403);
  const cleaned = await handle({
    method: "POST",
    path: "/v1/tasks/trash",
    query: new URLSearchParams(),
    headers: { "x-inventa-cron": "lixeira" },
    body: undefined,
    cookies: {},
  }, deps);
  assert.equal(cleaned.status, 200);
  assert.equal((cleaned.body as { removed: number }).removed, 1);
  assert.equal(await deps.store.findAsset("asset1234asset1234"), null);
});

test("placa ocupada devolve 503 se nao conseguir remarcar o job", async () => {
  const deps = makeDeps({
    enqueue: async () => "skipped",
  });
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
    workflows: ["zimage_t2i"],
    image_timeout_seconds: 480,
    video_timeout_seconds: 900,
  });
  const created = await handle({ ...post("/v1/jobs", { prompt: "um gato", workflow: "zimage_t2i" }), cookies }, deps);
  const jobId = (created.body as { jobs: { id: string }[] }).jobs[0].id;
  const stored = await deps.store.findJob(jobId);
  if (!stored) throw new Error("job ausente");
  stored.status = "running";
  stored.pod_id = "a6000-sp-1";
  await deps.store.saveJob(stored);
  const second = await handle({ ...post("/v1/jobs", { prompt: "outro gato", workflow: "zimage_t2i" }), cookies }, deps);
  const waitingId = (second.body as { jobs: { id: string }[] }).jobs[0].id;
  deps.config = { ...deps.config, role: "worker" };
  const response = await handle({
    method: "POST",
    path: "/v1/tasks/jobs",
    query: new URLSearchParams(),
    headers: { "x-cloudtasks-queuename": "inventa-jobs" },
    body: { jobId: waitingId },
    cookies: {},
  }, deps);
  assert.equal(response.status, 503);
  assert.equal((await deps.store.findJob(waitingId))?.status, "queued");
});

test("flux sem foto entra na mesma maquina e nao vira outro modelo na lista", async () => {
  const deps = makeDeps();
  const userId = "abc12345abc12345";
  await deps.store.saveUser({
    id: userId,
    email: "ana@invente.ai",
    password_hash: null,
    google_sub: null,
    email_verified: true,
    created_at: now.toISOString(),
    token_balance: 10000,
  });
  await deps.store.savePod({
    id: "a6000-sp-1",
    name: "a6000-sp-1",
    enabled: true,
    base_url: "https://pod.example",
    token_secret: "inventa-pod-a6000-sp-1-token",
    max_concurrent: 1,
    workflows: ["flux2_t2i"],
    image_timeout_seconds: 480,
    video_timeout_seconds: 900,
  });
  await deps.store.saveSession({ id: "sess1234sess1234", user_id: userId, expires_at: "2027-01-01T00:00:00.000Z" });
  const cookies = { invente_session: signSession({ sid: "sess1234sess1234", exp: Date.parse("2027-01-01T00:00:00.000Z") }, "teste-sessao-secreta") };
  const listed = await handle({ method: "GET", path: "/v1/workflows", query: new URLSearchParams(), headers: {}, body: undefined, cookies }, deps);
  const offers = (listed.body as { workflows: { id: string; label: string }[] }).workflows;
  assert.equal(offers.filter((item) => item.label === "Flux 2").length, 1);
  assert.equal(offers.some((item) => item.id === "flux2_text_t2i"), false);
  const created = await handle({ ...post("/v1/generate", { items: [{ workflow: "flux2_text_t2i", prompt: "um gato", kind: "image" }] }), cookies }, deps);
  assert.equal(created.status, 202);
  const body = created.body as { jobs: { workflow: string; token_cost: number }[] };
  assert.equal(body.jobs[0].workflow, "flux2_text_t2i");
  assert.equal(body.jobs[0].token_cost, resolveChoice("flux2_t2i")?.tokens);
  const prompted: { class_type: string }[] = [];
  deps.runPod = async (input) => {
    prompted.push(...Object.values(input.prompt));
    return { bytes: Buffer.from("png"), contentType: "image/png", podPath: "/workspace/ComfyUI/output/Flux2_dev_00001_.png" };
  };
  deps.config = { ...deps.config, role: "worker" };
  const done = await handle({
    method: "POST",
    path: "/v1/tasks/jobs",
    query: new URLSearchParams(),
    headers: { "x-cloudtasks-queuename": "inventa-jobs" },
    body: { jobId: body.jobs[0].id },
    cookies: {},
  }, deps);
  assert.equal(done.status, 200);
  assert.equal(prompted.some((node) => node.class_type === "LoadImage"), false);
  assert.equal(prompted.some((node) => node.class_type === "UNETLoader"), true);
});

function post(path: string, body: unknown) {
  return { method: "POST", path, query: new URLSearchParams(), headers: {}, body, cookies: {} };
}
