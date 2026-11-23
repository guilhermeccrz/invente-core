import { randomInt } from "node:crypto";
import type { Config } from "./config.js";
import { executionWorkflow, findWorkflow, loadWorkflow, podRuns } from "./catalog.js";
import { offersForPods, pricingHeader, resolveChoice, type Rates } from "./pricing.js";
import { uploadToComfy, type PodResult, type PodRun } from "./comfy.js";
import { EmailNotConfigured, notify, type Mailer } from "./email/notify.js";
import { objectName } from "./mediaPath.js";
import { hashPassword, verifyPassword } from "./password.js";
import { POLL_AFTER_MS, generatingProgress } from "./progress.js";
import { hashToken, newId, newToken, readSession, signSession } from "./session.js";
import { docsHtml, openApiSpec } from "./openapi.js";
import type { Asset, Job, JobStage, Pod, Store, User } from "./store.js";
import { swaggerFile } from "./swagger.js";
import { applyFrameSize, allowedFrame, IMAGE_FRAMES, patchWorkflow } from "./workflow.js";

const ALLOWED_ORIGINS = new Set(["https://invente.ai", "https://www.invente.ai", "http://localhost:3000"]);
const MAX_ITEMS = 4;
const MAX_ACTIVE = 4;
const IMAGE_HOUR = 30;
const VIDEO_HOUR = 5;
const TRASH_MS = 2 * 24 * 60 * 60 * 1000;
const STAGE_LABEL: Record<JobStage, string> = {
  queued: "Na fila",
  preparing: "Preparando",
  generating: "Gerando",
  saving: "Salvando",
  done: "Pronto",
  error: "Falhou",
};

export type AppRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  cookies: Record<string, string>;
};

export type AppResponse = {
  status: number;
  body?: unknown;
  headers: Record<string, string>;
  raw?: string | Buffer;
};

export type { PodResult };

export type Deps = {
  config: Config;
  store: Store;
  mailer: Mailer;
  now: () => Date;
  enqueue: (jobId: string, delaySeconds?: number) => Promise<"sent" | "skipped">;
  runPod: (input: PodRun) => Promise<PodResult>;
  readPodToken: (secretName: string) => Promise<string>;
  loadMedia: (name: string) => Promise<Buffer>;
  signMedia: (name: string) => Promise<string>;
  deleteMedia: (name: string) => Promise<void>;
  saveMedia: (name: string, bytes: Buffer, contentType: string) => Promise<void>;
  exchangeGoogleCode: (code: string) => Promise<{ sub: string; email: string }>;
};

export async function handle(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const origin = req.headers.origin || "";
  const cors = corsHeaders(origin, deps.config.publicAppUrl);
  if (req.method === "OPTIONS") return { status: 204, headers: cors };
  try {
    const response = await route(req, deps);
    return { ...response, headers: { ...cors, ...response.headers } };
  } catch (error) {
    if (error instanceof EmailNotConfigured) return json(503, { error: "email_not_configured" }, cors);
    if (error instanceof Error && error.message === "senha curta") return json(400, { error: "senha_curta" }, cors);
    return json(500, { error: "erro_interno" }, cors);
  }
}

async function route(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const { method, path } = req;
  if (method === "GET" && path === "/health") return json(200, { ok: true, role: deps.config.role });
  if (method === "GET" && path === "/openapi.json") {
    return json(200, openApiSpec(deps.config.publicApiUrl));
  }
  if (method === "GET" && path === "/docs") {
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, raw: docsHtml };
  }
  if (method === "GET" && path.startsWith("/docs/")) {
    const file = swaggerFile(path.slice("/docs/".length));
    if (!file) return json(404, { error: "nao_encontrado" });
    return { status: 200, headers: { "content-type": file.type }, raw: file.body };
  }
  if (method === "POST" && path === "/v1/auth/register") return register(req, deps);
  if (method === "POST" && path === "/v1/auth/verify") return verifyEmail(req, deps);
  if (method === "POST" && path === "/v1/auth/login") return login(req, deps);
  if (method === "POST" && path === "/v1/auth/logout") return logout(req, deps);
  if (method === "POST" && path === "/v1/auth/forgot") return forgot(req, deps);
  if (method === "POST" && path === "/v1/auth/reset") return resetPassword(req, deps);
  if (method === "GET" && path === "/v1/auth/google/start") return googleStart(req, deps);
  if (method === "GET" && path === "/v1/auth/google/callback") return googleCallback(req, deps);
  if (method === "GET" && path === "/v1/me") return me(req, deps);
  if (method === "GET" && path === "/v1/workflows") return listWorkflows(deps);
  if (method === "GET" && path === "/v1/gallery") return listGallery(req, deps);
  if (method === "GET" && path === "/v1/community") return listCommunity(deps);
  if (method === "GET" && path.startsWith("/v1/community/")) return readCommunityImage(deps, path.slice("/v1/community/".length));
  if (method === "POST" && path.startsWith("/v1/gallery/") && path.endsWith("/restore")) return restoreGalleryItem(req, deps, path.slice("/v1/gallery/".length, -"/restore".length));
  if (method === "POST" && path === "/v1/assets") return uploadReference(req, deps);
  if (method === "GET" && path.startsWith("/v1/media/")) return readMedia(req, deps, path.slice("/v1/media/".length));
  if (method === "DELETE" && path.startsWith("/v1/gallery/")) return deleteGalleryItem(req, deps, path.slice("/v1/gallery/".length));
  if (method === "POST" && path === "/v1/generate") return createJobs(req, deps);
  if (method === "POST" && path === "/v1/jobs") return createJobs(req, deps);
  if (method === "GET" && path === "/v1/jobs") return listJobs(req, deps);
  if (method === "GET" && path.startsWith("/v1/jobs/")) return getJob(req, deps, path.slice("/v1/jobs/".length));
  if (method === "POST" && path === "/v1/tasks/jobs") return runTask(req, deps);
  if (method === "POST" && path === "/v1/tasks/trash") return runTrash(req, deps);
  return json(404, { error: "nao_encontrado" });
}

async function runTrash(req: AppRequest, deps: Deps): Promise<AppResponse> {
  if (deps.config.role !== "worker") return json(404, { error: "nao_encontrado" });
  const fromQueue = req.headers["x-cloudtasks-queuename"] === deps.config.tasksQueue;
  const fromCron = req.headers["x-inventa-cron"] === "lixeira";
  if (!fromQueue && !fromCron) return json(403, { error: "fila_invalida" });
  const before = new Date(deps.now().getTime() - TRASH_MS).toISOString();
  const expired = await deps.store.listExpiredAssets(before);
  for (const asset of expired) {
    await deps.deleteMedia(asset.object_name);
    await deps.store.deleteAsset(asset.id);
  }
  return json(200, { removed: expired.length });
}

async function register(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const email = readEmail(req.body);
  const password = readString(req.body, "password");
  if (!email || !password) return json(400, { error: "dados_invalidos" });
  if (await deps.store.findUserByEmail(email)) return json(409, { error: "email_em_uso" });
  const user: User = {
    id: newId(),
    email,
    password_hash: await hashPassword(password),
    google_sub: null,
    email_verified: false,
    created_at: deps.now().toISOString(),
    token_balance: 0,
  };
  const token = newToken();
  const tokenDoc = {
    id: newId(),
    user_id: user.id,
    token_hash: hashToken(token),
    expires_at: new Date(deps.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
  await deps.store.saveUser(user);
  await deps.store.saveToken("email_verify", tokenDoc);
  try {
    await notify(deps.mailer, { kind: "verify", to: email, link: `${deps.config.publicApiUrl}/v1/auth/verify?token=${token}` });
  } catch (error) {
    await deps.store.deleteUser(user.id);
    await deps.store.deleteToken("email_verify", tokenDoc.id);
    throw error;
  }
  return json(201, { id: user.id, email });
}

async function verifyEmail(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const token = readString(req.body, "token") || req.query.get("token") || "";
  if (!token) return json(400, { error: "token_ausente" });
  const doc = await deps.store.findToken("email_verify", hashToken(token));
  if (!doc || doc.expires_at <= deps.now().toISOString()) return json(400, { error: "token_invalido" });
  const user = await deps.store.findUserById(doc.user_id);
  if (!user) return json(400, { error: "token_invalido" });
  user.email_verified = true;
  await deps.store.saveUser(user);
  await deps.store.deleteToken("email_verify", doc.id);
  return json(200, { ok: true });
}

async function login(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const email = readEmail(req.body);
  const password = readString(req.body, "password");
  const user = email ? await deps.store.findUserByEmail(email) : null;
  if (!user?.password_hash || !password || !(await verifyPassword(password, user.password_hash))) {
    return json(401, { error: "credenciais_invalidas" });
  }
  if (!user.email_verified) return json(403, { error: "email_nao_confirmado" });
  return openSession(user, req, deps);
}

async function logout(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const session = await currentSession(req, deps);
  if (session) await deps.store.deleteSession(session.id);
  return { status: 204, headers: { "set-cookie": sessionCookie("", req, deps, 0) } };
}

async function forgot(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const email = readEmail(req.body);
  if (!email) return json(400, { error: "dados_invalidos" });
  const user = await deps.store.findUserByEmail(email);
  if (!user) return json(202, { ok: true });
  const token = newToken();
  const tokenDoc = {
    id: newId(),
    user_id: user.id,
    token_hash: hashToken(token),
    expires_at: new Date(deps.now().getTime() + 60 * 60 * 1000).toISOString(),
  };
  await deps.store.saveToken("password_reset", tokenDoc);
  try {
    await notify(deps.mailer, { kind: "reset", to: email, link: `${deps.config.publicAppUrl}/redefinir?token=${token}` });
  } catch (error) {
    await deps.store.deleteToken("password_reset", tokenDoc.id);
    throw error;
  }
  return json(202, { ok: true });
}

async function resetPassword(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const token = readString(req.body, "token");
  const password = readString(req.body, "password");
  if (!token || !password) return json(400, { error: "dados_invalidos" });
  const doc = await deps.store.findToken("password_reset", hashToken(token));
  if (!doc || doc.expires_at <= deps.now().toISOString()) return json(400, { error: "token_invalido" });
  const user = await deps.store.findUserById(doc.user_id);
  if (!user) return json(400, { error: "token_invalido" });
  user.password_hash = await hashPassword(password);
  await deps.store.saveUser(user);
  await deps.store.deleteToken("password_reset", doc.id);
  return json(200, { ok: true });
}

function googleStart(req: AppRequest, deps: Deps): AppResponse {
  if (!deps.config.googleClientId) return json(503, { error: "google_nao_configurado" });
  const state = newToken();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", deps.config.googleClientId);
  url.searchParams.set("redirect_uri", `${deps.config.publicAppUrl}/v1/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  const secure = req.headers["x-forwarded-proto"] === "https" || deps.config.publicAppUrl.startsWith("https://");
  return {
    status: 302,
    headers: {
      location: url.toString(),
      "set-cookie": `invente_google_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${secure ? "; Secure" : ""}`,
    },
  };
}

async function googleCallback(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const code = req.query.get("code") || "";
  const state = req.query.get("state") || "";
  if (!code || !state || state !== req.cookies.invente_google_state) return json(400, { error: "state_invalido" });
  const profile = await deps.exchangeGoogleCode(code);
  const email = profile.email.trim().toLowerCase();
  let user = (await deps.store.findUserByGoogleSub(profile.sub)) ?? (await deps.store.findUserByEmail(email));
  if (!user) {
    user = {
      id: newId(),
      email,
      password_hash: null,
      google_sub: profile.sub,
      email_verified: true,
      created_at: deps.now().toISOString(),
      token_balance: 0,
    };
  }
  user.token_balance = user.token_balance ?? 0;
  user.google_sub = profile.sub;
  user.email_verified = true;
  await deps.store.saveUser(user);
  const response = await openSession(user, req, deps);
  response.status = 302;
  response.headers.location = deps.config.publicAppUrl;
  return response;
}

async function me(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  return json(200, { id: user.id, email: user.email, token_balance: user.token_balance ?? 0 });
}

async function listWorkflows(deps: Deps): Promise<AppResponse> {
  const rates = ratesOf(deps.config);
  return json(200, {
    ...pricingHeader(rates),
    workflows: offersForPods(await deps.store.listPods(), rates),
    poll_after_ms: POLL_AFTER_MS,
    frames: IMAGE_FRAMES,
  });
}

async function createJobs(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  const parsed = parseItems(req.body, req.path === "/v1/jobs", ratesOf(deps.config));
  if ("error" in parsed) return json(parsed.status, { error: parsed.error });
  const pods = (await deps.store.listPods()).filter((pod) => pod.enabled);
  for (const item of parsed.items) {
    if (!pods.some((pod) => podRuns(pod.workflows, item.workflow))) return json(409, { error: "workflow_indisponivel" });
    const assetError = await validateAssets(deps, user.id, item);
    if (assetError) return json(400, { error: assetError });
  }
  const latest = await deps.store.listJobs(user.id);
  const active = latest.filter((job) => job.status === "queued" || job.status === "running");
  if (active.length + parsed.items.length > MAX_ACTIVE) return json(429, { error: "fila_cheia" });
  const since = new Date(deps.now().getTime() - 60 * 60 * 1000).toISOString();
  const recent = latest.filter((job) => job.created_at >= since);
  const images = recent.filter((job) => job.kind === "image").length + parsed.items.filter((item) => item.kind === "image").length;
  const videos = recent.filter((job) => job.kind === "video").length + parsed.items.filter((item) => item.kind === "video").length;
  if (images > IMAGE_HOUR) return json(429, { error: "cota_imagem" });
  if (videos > VIDEO_HOUR) return json(429, { error: "cota_video" });
  const total = parsed.items.reduce((sum, item) => sum + item.tokens, 0);
  const charged = await deps.store.adjustTokens({
    userId: user.id,
    delta: -total,
    at: deps.now().toISOString(),
    reason: "geracao",
    jobId: null,
    note: parsed.items.map((item) => item.requested).join(","),
  });
  if ("error" in charged) return json(402, { error: "saldo_insuficiente", token_balance: user.token_balance ?? 0 });
  const jobs = [];
  try {
    for (const item of parsed.items) {
      const now = deps.now().toISOString();
      const job: Job = {
        id: newId(),
        user_id: user.id,
        status: "queued",
        stage: "queued",
        progress: 0,
        created_at: now,
        updated_at: now,
        started_at: null,
        timeout_seconds: item.kind === "video" ? 900 : 480,
        prompt: item.prompt,
        workflow: item.workflow,
        kind: item.kind,
        seed: item.seed ?? randomInt(1, 2 ** 47),
        image_asset_id: item.image_asset_id,
        video_asset_id: item.video_asset_id,
        width: item.width,
        height: item.height,
        pod_id: null,
        asset_id: null,
        error: null,
        pod_path: null,
        mode: item.mode,
        token_cost: item.tokens,
        tokens_state: "held",
      };
      await deps.store.saveJob(job);
      const delivery = await deps.enqueue(job.id);
      jobs.push({ ...present(job, deps.now()), delivery });
    }
  } catch (error) {
    await deps.store.adjustTokens({
      userId: user.id,
      delta: total,
      at: deps.now().toISOString(),
      reason: "estorno",
      jobId: null,
      note: "fila_nao_gravou",
    });
    throw error;
  }
  return json(202, { jobs, poll_after_ms: POLL_AFTER_MS, token_balance: charged.balance });
}

async function listJobs(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  const jobs = await deps.store.listJobs(user.id);
  return json(200, { jobs: jobs.map((job) => present(job, deps.now())), poll_after_ms: POLL_AFTER_MS });
}

async function getJob(req: AppRequest, deps: Deps, id: string): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  const job = await deps.store.findJob(id);
  if (!job || job.user_id !== user.id) return json(404, { error: "nao_encontrado" });
  if (job.status === "queued" && deps.now().getTime() - Date.parse(job.updated_at) > 60_000) {
    const again = await deps.enqueue(job.id);
    if (again === "sent") {
      job.updated_at = deps.now().toISOString();
      await deps.store.saveJob(job);
    }
  }
  let resultUrl: string | undefined;
  if (job.status === "done" && job.asset_id) {
    const asset = await deps.store.findAsset(job.asset_id);
    if (asset) {
      try {
        resultUrl = await deps.signMedia(asset.object_name);
      } catch {
        resultUrl = undefined;
      }
    }
  }
  return json(200, { ...present(job, deps.now()), result_url: resultUrl });
}

async function runTask(req: AppRequest, deps: Deps): Promise<AppResponse> {
  if (deps.config.role !== "worker") return json(404, { error: "nao_encontrado" });
  if (req.headers["x-cloudtasks-queuename"] !== deps.config.tasksQueue) return json(403, { error: "fila_invalida" });
  const jobId = readString(req.body, "jobId");
  const job = jobId ? await deps.store.findJob(jobId) : null;
  if (!job || job.status === "done" || job.status === "error" || job.status === "running") return json(200, { ok: true, ignored: true });
  const pod = (await deps.store.listPods()).find((item) => item.enabled && podRuns(item.workflows, job.workflow));
  if (!pod) return failJob(job, deps, "pod_not_configured", true);
  const claim = await deps.store.claimJob(job.id, pod.id, pod.max_concurrent);
  if (claim === "busy") {
    const again = await deps.enqueue(job.id, 30);
    if (again !== "sent") return json(503, { error: "fila_ocupada" });
    return json(200, { ok: true, delayed: true });
  }
  if (claim !== "claimed") return json(200, { ok: true, ignored: true });
  job.status = "running";
  job.stage = "preparing";
  job.progress = 15;
  job.pod_id = pod.id;
  const user = await deps.store.findUserById(job.user_id);
  try {
    const result = await generate(job, pod, deps);
    job.stage = "saving";
    job.progress = 95;
    job.updated_at = deps.now().toISOString();
    await deps.store.saveJob(job);
    const assetId = newId();
    const name = objectName(deps.config.mediaPrefix, job.user_id, job.kind, assetId, extOf(result.contentType, result.podPath));
    await deps.saveMedia(name, result.bytes, result.contentType);
    const asset: Asset = {
      id: assetId,
      user_id: job.user_id,
      created_at: deps.now().toISOString(),
      object_name: name,
      content_type: result.contentType,
      job_id: job.id,
      kind: job.kind,
      workflow: job.workflow,
      prompt: job.prompt,
      mode: job.mode,
    };
    await deps.store.saveAsset(asset);
    job.status = "done";
    job.stage = "done";
    job.progress = 100;
    job.asset_id = assetId;
    job.pod_path = result.podPath;
    job.error = null;
    job.tokens_state = "spent";
    job.updated_at = deps.now().toISOString();
    await deps.store.saveJob(job);
    if (user) {
      try {
        await notify(deps.mailer, { kind: "job_ready", to: user.email, jobId: job.id, link: `${deps.config.publicAppUrl}/jobs/${job.id}` });
      } catch {
        // O arquivo já está no bucket. O aviso não desfaz a geração.
      }
    }
    return json(200, { ok: true, asset_id: assetId });
  } catch (error) {
    const reason = safeReason(error);
    const retry = Number(req.headers["x-cloudtasks-taskretrycount"] || "0");
    const giveUp = terminal(reason) || retry >= 2;
    return failJob(job, deps, reason, giveUp, user);
  }
}

async function generate(job: Job, pod: Pod, deps: Deps): Promise<PodResult> {
  const graph = executionWorkflow(job.workflow, Boolean(job.image_asset_id));
  const spec = findWorkflow(graph);
  if (!spec) throw new Error("workflow_invalido");
  const loaded = loadWorkflow(graph);
  const token = await deps.readPodToken(pod.token_secret);
  if (!token) throw new Error("pod_not_configured");
  let imageName: string | null = null;
  let videoName: string | null = null;
  if (job.image_asset_id && loaded.manifest.load_image) {
    imageName = await uploadAsset(deps, pod, token, job.user_id, job.image_asset_id);
  }
  if (job.video_asset_id && loaded.manifest.load_video) {
    videoName = await uploadAsset(deps, pod, token, job.user_id, job.video_asset_id);
  }
  const prompt = patchWorkflow(loaded.prompt, loaded.manifest, {
    prompt: job.prompt,
    seed: job.seed,
    imageName,
    videoName,
    disconnectImage: spec.drops_image === true && !job.image_asset_id,
  });
  if (job.width && job.height) applyFrameSize(prompt, graph, job.width, job.height);
  const timeoutMs = (job.kind === "video" ? pod.video_timeout_seconds : pod.image_timeout_seconds) * 1000;
  return deps.runPod({
    baseUrl: pod.base_url,
    token,
    prompt,
    timeoutMs,
    outputNode: loaded.manifest.output_node,
    onAccepted: async () => {
      job.stage = "generating";
      job.progress = 35;
      job.started_at = deps.now().toISOString();
      job.timeout_seconds = job.kind === "video" ? pod.video_timeout_seconds : pod.image_timeout_seconds;
      job.updated_at = job.started_at;
      await deps.store.saveJob(job);
    },
  });
}

async function failJob(job: Job, deps: Deps, reason: string, giveUp: boolean, user?: User | null): Promise<AppResponse> {
  const account = user === undefined ? await deps.store.findUserById(job.user_id) : user;
  job.pod_id = null;
  job.updated_at = deps.now().toISOString();
  if (!giveUp) {
    job.status = "queued";
    job.stage = "queued";
    job.progress = 0;
    job.error = null;
    await deps.store.saveJob(job);
    return json(503, { error: "falha_transitiva" });
  }
  job.status = "error";
  job.stage = "error";
  job.error = reason;
  if (job.tokens_state === "held" && job.token_cost > 0) {
    const refund = await deps.store.adjustTokens({
      userId: job.user_id,
      delta: job.token_cost,
      at: deps.now().toISOString(),
      reason: "estorno",
      jobId: job.id,
      note: reason,
    });
    if (!("error" in refund)) {
      if (account) account.token_balance = refund.balance;
      job.tokens_state = "refunded";
    }
  }
  await deps.store.saveJob(job);
  if (account) {
    try {
      await notify(deps.mailer, { kind: "job_failed", to: account.email, jobId: job.id, reason });
    } catch {
      // A falha da geração já ficou registrada.
    }
  }
  return json(200, { ok: false, error: reason });
}

async function uploadAsset(deps: Deps, pod: Pod, token: string, userId: string, assetId: string): Promise<string> {
  const asset = await deps.store.findAsset(assetId);
  if (!asset || asset.user_id !== userId) throw new Error("asset_ausente");
  const bytes = await deps.loadMedia(asset.object_name);
  const filename = (asset.object_name.split("/").pop() || "entrada.bin").replace(/[^A-Za-z0-9._-]/g, "");
  return uploadToComfy(pod.base_url, token, bytes, filename);
}

async function validateAssets(deps: Deps, userId: string, item: Item): Promise<string | null> {
  if (item.image_asset_id) {
    const asset = await deps.store.findAsset(item.image_asset_id);
    if (!asset || asset.user_id !== userId || asset.kind !== "image" || asset.deleted_at) return "asset_ausente";
  }
  if (item.video_asset_id) {
    const asset = await deps.store.findAsset(item.video_asset_id);
    if (!asset || asset.user_id !== userId || asset.kind !== "video" || asset.deleted_at) return "asset_ausente";
  }
  return null;
}

function present(job: Job, now: Date) {
  const progress =
    job.stage === "generating" && job.started_at
      ? generatingProgress(Date.parse(job.started_at), now.getTime(), job.timeout_seconds || 480)
      : job.progress;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    stage_label: STAGE_LABEL[job.stage],
    progress,
    poll_after_ms: POLL_AFTER_MS,
    workflow: job.workflow,
    kind: job.kind,
    seed: job.seed,
    prompt: job.prompt,
    created_at: job.created_at,
    started_at: job.started_at,
    timeout_seconds: job.timeout_seconds,
    asset_id: job.asset_id,
    pod_path: job.pod_path,
    error: job.error,
    mode: job.mode,
    token_cost: job.token_cost,
    media_path: job.asset_id ? `/v1/media/${job.asset_id}` : null,
  };
}

async function listCommunity(deps: Deps): Promise<AppResponse> {
  const assets = await deps.store.listRecentImages(3);
  return json(200, {
    items: assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      prompt: asset.prompt,
      created_at: asset.created_at,
      result_url: `/v1/community/${asset.id}`,
    })),
  });
}

async function readCommunityImage(deps: Deps, id: string): Promise<AppResponse> {
  const asset = await deps.store.findAsset(id);
  const recent = await deps.store.listRecentImages(3);
  if (!asset || !recent.some((item) => item.id === asset.id)) return json(404, { error: "nao_encontrado" });
  const bytes = await deps.loadMedia(asset.object_name);
  return {
    status: 200,
    headers: { "content-type": asset.content_type || "image/png", "cache-control": "public, max-age=300" },
    raw: bytes,
  };
}

async function listGallery(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  const kind = req.query.get("kind");
  const trash = req.query.get("trash") === "1";
  const now = deps.now().getTime();
  const assets = await deps.store.listAssets(user.id);
  for (const asset of assets) {
    if (!asset.deleted_at || Date.parse(asset.deleted_at) + TRASH_MS > now) continue;
    await deps.deleteMedia(asset.object_name);
    await deps.store.deleteAsset(asset.id);
  }
  const visible = assets.filter((asset) => {
    if (asset.deleted_at && Date.parse(asset.deleted_at) + TRASH_MS <= now) return false;
    if (trash) return Boolean(asset.deleted_at);
    return !asset.deleted_at;
  }).filter((asset) => !kind || asset.kind === kind);
  const items = [];
  for (const asset of visible) {
    let resultUrl: string | undefined;
    try {
      resultUrl = await deps.signMedia(asset.object_name);
    } catch {
      resultUrl = undefined;
    }
    items.push({
      id: asset.id,
      kind: asset.kind,
      workflow: asset.workflow,
      mode: asset.mode,
      prompt: asset.prompt,
      created_at: asset.created_at,
      deleted_at: asset.deleted_at || null,
      job_id: asset.job_id,
      result_url: resultUrl,
      media_path: `/v1/media/${asset.id}`,
    });
  }
  return json(200, { items });
}

async function deleteGalleryItem(req: AppRequest, deps: Deps, id: string): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  const asset = await deps.store.findAsset(id);
  if (!asset || asset.user_id !== user.id) return json(404, { error: "nao_encontrado" });
  if (asset.deleted_at) {
    await deps.deleteMedia(asset.object_name);
    await deps.store.deleteAsset(asset.id);
    return { status: 204, headers: {} };
  }
  asset.deleted_at = deps.now().toISOString();
  await deps.store.saveAsset(asset);
  return { status: 204, headers: {} };
}

async function restoreGalleryItem(req: AppRequest, deps: Deps, id: string): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  const asset = await deps.store.findAsset(id);
  if (!asset || asset.user_id !== user.id || !asset.deleted_at) return json(404, { error: "nao_encontrado" });
  asset.deleted_at = null;
  await deps.store.saveAsset(asset);
  return json(200, { ok: true });
}

function ratesOf(config: Config): Rates {
  return { podUsdPerHour: config.podUsdPerHour, tokenUsd: config.tokenUsd, margin: config.tokenMargin };
}

function parseItems(body: unknown, legacy: boolean, rates: Rates): { items: Item[] } | { error: string; status: number } {
  const raw = readItemList(body, legacy);
  if (raw.length === 0 || raw.length > MAX_ITEMS) return { error: "dados_invalidos", status: 400 };
  const items: Item[] = [];
  for (const entry of raw) {
    const requested = readString(entry, "workflow") || (legacy ? "zimage_t2i" : "");
    const choice = resolveChoice(requested, rates);
    if (!choice) return { error: "workflow_invalido", status: 400 };
    const spec = choice.spec;
    const kindField = readString(entry, "kind");
    if (kindField && kindField !== choice.kind) return { error: "dados_invalidos", status: 400 };
    const prompt = readString(entry, "prompt");
    if (prompt.length > 2000 || (spec.prompt === "required" && !prompt)) return { error: "prompt_invalido", status: 400 };
    const image = readNullable(entry, "image_asset_id");
    const video = readNullable(entry, "video_asset_id");
    if (spec.image === "required" && !image) return { error: "asset_ausente", status: 400 };
    if (spec.video === "required" && !video) return { error: "asset_ausente", status: 400 };
    const frame = readFrame(entry);
    if (frame === "invalid") return { error: "dados_invalidos", status: 400 };
    const count = readCount(entry);
    if (count === null) return { error: "dados_invalidos", status: 400 };
    const seed = readSeed(entry);
    for (let index = 0; index < count; index += 1) {
      items.push({
        requested: choice.requested,
        workflow: choice.workflow,
        mode: choice.mode,
        tokens: choice.tokens,
        kind: choice.kind,
        prompt,
        seed: index === 0 ? seed : null,
        image_asset_id: image,
        video_asset_id: video,
        width: frame?.width ?? null,
        height: frame?.height ?? null,
      });
    }
  }
  if (items.length > MAX_ITEMS) return { error: "dados_invalidos", status: 400 };
  return { items };
}

function readItemList(body: unknown, legacy: boolean): unknown[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items.filter((item) => item && typeof item === "object");
  if (legacy && (typeof record.prompt === "string" || typeof record.workflow === "string")) return [record];
  return [];
}

function terminal(reason: string): boolean {
  return reason === "pod_not_configured" || reason === "workflow_invalido" || reason === "asset_ausente" || reason.startsWith("comfy_rejeitou") || reason.startsWith("comfy_timeout");
}

function safeReason(error: unknown): string {
  const text = error instanceof Error ? error.message : "falha";
  return text.replace(/bearer\s+\S+/gi, "bearer").replace(/\s+/g, " ").slice(0, 180);
}

async function openSession(user: User, req: AppRequest, deps: Deps): Promise<AppResponse> {
  const exp = deps.now().getTime() + 14 * 24 * 60 * 60 * 1000;
  const session = { id: newId(), user_id: user.id, expires_at: new Date(exp).toISOString() };
  await deps.store.saveSession(session);
  const token = signSession({ sid: session.id, exp }, deps.config.sessionSecret);
  return {
    status: 200,
    body: { id: user.id, email: user.email, token_balance: user.token_balance ?? 0 },
    headers: { "set-cookie": sessionCookie(token, req, deps, 14 * 24 * 60 * 60) },
  };
}

async function currentUser(req: AppRequest, deps: Deps): Promise<User | null> {
  const session = await currentSession(req, deps);
  if (!session) return null;
  return deps.store.findUserById(session.user_id);
}

async function currentSession(req: AppRequest, deps: Deps) {
  const token = req.cookies.invente_session;
  if (!token) return null;
  const payload = readSession(token, deps.config.sessionSecret, deps.now().getTime());
  if (!payload) return null;
  const session = await deps.store.findSession(payload.sid);
  if (!session || session.expires_at <= deps.now().toISOString()) return null;
  return session;
}

function sessionCookie(token: string, req: AppRequest, deps: Deps, maxAge: number): string {
  const proto = req.headers["x-forwarded-proto"];
  const secure = proto === "http" ? false : proto === "https" || deps.config.publicApiUrl.startsWith("https://");
  return `invente_session=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

const UPLOAD_LIMIT = 12 * 1024 * 1024;
const UPLOAD_TYPES: Record<string, { kind: "image" | "video"; ext: string }> = {
  "image/png": { kind: "image", ext: "png" },
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/webp": { kind: "image", ext: "webp" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/webm": { kind: "video", ext: "webm" },
};

async function uploadReference(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  const record = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const declared = typeof record.content_type === "string" ? record.content_type : "";
  const spec = UPLOAD_TYPES[declared];
  const kind = readString(record, "kind");
  if (!spec || kind !== spec.kind) return json(400, { error: "dados_invalidos" });
  const encoded = typeof record.data_base64 === "string" ? record.data_base64 : "";
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    return json(400, { error: "dados_invalidos" });
  }
  if (bytes.length === 0 || bytes.length > UPLOAD_LIMIT) return json(400, { error: "dados_invalidos" });
  const assetId = newId();
  const name = objectName(deps.config.mediaPrefix, user.id, spec.kind, assetId, spec.ext);
  await deps.saveMedia(name, bytes, declared);
  const asset: Asset = {
    id: assetId,
    user_id: user.id,
    created_at: deps.now().toISOString(),
    object_name: name,
    content_type: declared,
    job_id: assetId,
    kind: spec.kind,
    workflow: "referencia",
    prompt: "Referência",
    mode: "manual",
  };
  await deps.store.saveAsset(asset);
  return json(201, { id: asset.id, kind: asset.kind, workflow: "referencia", media_path: `/v1/media/${asset.id}` });
}

async function readMedia(req: AppRequest, deps: Deps, id: string): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  const asset = await deps.store.findAsset(id);
  if (!asset || asset.user_id !== user.id) return json(404, { error: "nao_encontrado" });
  const bytes = await deps.loadMedia(asset.object_name);
  return {
    status: 200,
    headers: { "content-type": asset.content_type || "application/octet-stream", "cache-control": "private, max-age=60" },
    raw: bytes,
  };
}

function corsHeaders(origin: string, appUrl: string): Record<string, string> {
  if (!origin || (!ALLOWED_ORIGINS.has(origin) && origin !== appUrl)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    vary: "Origin",
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): AppResponse {
  return { status, body, headers: { "content-type": "application/json; charset=utf-8", ...headers } };
}

function readEmail(body: unknown): string {
  const value = readString(body, "email");
  if (!value || !value.includes("@") || value.length > 200) return "";
  return value.trim().toLowerCase();
}

type Item = {
  requested: string;
  workflow: string;
  mode: "auto" | "manual";
  tokens: number;
  kind: "image" | "video";
  prompt: string;
  seed: number | null;
  image_asset_id: string | null;
  video_asset_id: string | null;
  width: number | null;
  height: number | null;
};

function readString(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || !(key in body)) return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readNullable(body: unknown, key: string): string | null {
  return readString(body, key) || null;
}

function readCount(body: unknown): number | null {
  if (!body || typeof body !== "object" || !("count" in body) || (body as Record<string, unknown>).count === undefined) return 1;
  const value = (body as Record<string, unknown>).count;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_ITEMS) return null;
  return value;
}

function readFrame(body: unknown): { width: number; height: number } | null | "invalid" {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.width === undefined && record.height === undefined) return null;
  if (typeof record.width !== "number" || typeof record.height !== "number") return "invalid";
  if (!allowedFrame(record.width, record.height)) return "invalid";
  return { width: record.width, height: record.height };
}

function readSeed(body: unknown): number | null {
  if (!body || typeof body !== "object" || !("seed" in body)) return null;
  const value = (body as Record<string, unknown>).seed;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= 2 ** 53) return null;
  return value;
}

function extOf(contentType: string, podPath: string): string {
  const fromName = podPath.split(".").pop()?.toLowerCase() || "";
  if (fromName === "jpeg") return "jpg";
  if (["png", "jpg", "webp", "gif", "mp4", "webm"].includes(fromName)) return fromName;
  if (contentType.includes("mp4")) return "mp4";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}
