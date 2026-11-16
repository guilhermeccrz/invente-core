import type { Config } from "./config.js";
import { EmailNotConfigured, notify, type Mailer } from "./email/notify.js";
import { objectName } from "./mediaPath.js";
import { hashPassword, verifyPassword } from "./password.js";
import { hashToken, newId, newToken, readSession, signSession } from "./session.js";
import { docsHtml, openApiSpec } from "./openapi.js";
import type { Job, Store, User } from "./store.js";
import { swaggerFile } from "./swagger.js";

const ALLOWED_WORKFLOW = "zimage_t2i";
const ALLOWED_ORIGINS = new Set(["https://invente.ai", "https://www.invente.ai", "http://localhost:3000"]);

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
  raw?: string;
};

export type PodResult = { bytes: Buffer; contentType: string };

export type Deps = {
  config: Config;
  store: Store;
  mailer: Mailer;
  now: () => Date;
  enqueue: (jobId: string) => Promise<"sent" | "skipped">;
  runPod: (input: { workflow: string; prompt: string; jobId: string }) => Promise<PodResult>;
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
  if (method === "GET" && path === "/v1/auth/google/start") return googleStart(deps);
  if (method === "GET" && path === "/v1/auth/google/callback") return googleCallback(req, deps);
  if (method === "GET" && path === "/v1/me") return me(req, deps);
  if (method === "POST" && path === "/v1/jobs") return createJob(req, deps);
  if (method === "GET" && path === "/v1/jobs") return listJobs(req, deps);
  if (method === "GET" && path.startsWith("/v1/jobs/")) return getJob(req, deps, path.slice("/v1/jobs/".length));
  if (method === "POST" && path === "/v1/tasks/jobs") return runTask(req, deps);
  return json(404, { error: "nao_encontrado" });
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
  return openSession(user, deps);
}

async function logout(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const session = await currentSession(req, deps);
  if (session) await deps.store.deleteSession(session.id);
  return { status: 204, headers: { "set-cookie": sessionCookie("", deps, 0) } };
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

function googleStart(deps: Deps): AppResponse {
  if (!deps.config.googleClientId) return json(503, { error: "google_nao_configurado" });
  const state = newToken();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", deps.config.googleClientId);
  url.searchParams.set("redirect_uri", `${deps.config.publicApiUrl}/v1/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  return {
    status: 302,
    headers: {
      location: url.toString(),
      "set-cookie": "invente_google_state=" + state + "; HttpOnly; Path=/; Max-Age=600; SameSite=Lax",
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
    };
  }
  user.google_sub = profile.sub;
  user.email_verified = true;
  await deps.store.saveUser(user);
  const response = await openSession(user, deps);
  response.status = 302;
  response.headers.location = deps.config.publicAppUrl;
  return response;
}

async function me(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  return json(200, { id: user.id, email: user.email });
}

async function createJob(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  const prompt = readString(req.body, "prompt");
  const workflow = readString(req.body, "workflow") || ALLOWED_WORKFLOW;
  if (!prompt || prompt.length > 2000) return json(400, { error: "prompt_invalido" });
  if (workflow !== ALLOWED_WORKFLOW) return json(400, { error: "workflow_invalido" });
  const job: Job = {
    id: newId(),
    user_id: user.id,
    status: "queued",
    created_at: deps.now().toISOString(),
    prompt,
    workflow,
    pod_id: null,
    asset_id: null,
    error: null,
  };
  await deps.store.saveJob(job);
  const delivery = await deps.enqueue(job.id);
  return json(202, { ...job, delivery });
}

async function listJobs(req: AppRequest, deps: Deps): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  return json(200, { jobs: await deps.store.listJobs(user.id) });
}

async function getJob(req: AppRequest, deps: Deps, id: string): Promise<AppResponse> {
  const user = await currentUser(req, deps);
  if (!user) return json(401, { error: "sem_sessao" });
  const job = await deps.store.findJob(id);
  if (!job || job.user_id !== user.id) return json(404, { error: "nao_encontrado" });
  return json(200, job);
}

async function runTask(req: AppRequest, deps: Deps): Promise<AppResponse> {
  if (deps.config.role !== "worker") return json(404, { error: "nao_encontrado" });
  if (req.headers["x-cloudtasks-queuename"] !== deps.config.tasksQueue) return json(403, { error: "fila_invalida" });
  const jobId = readString(req.body, "jobId");
  const job = jobId ? await deps.store.findJob(jobId) : null;
  if (!job || job.status === "succeeded") return json(200, { ok: true, ignored: true });
  const user = await deps.store.findUserById(job.user_id);
  job.status = "running";
  await deps.store.saveJob(job);
  try {
    const result = await deps.runPod({ workflow: job.workflow, prompt: job.prompt, jobId: job.id });
    const assetId = newId();
    const name = objectName(deps.config.mediaPrefix, job.user_id, assetId, extOf(result.contentType));
    await deps.saveMedia(name, result.bytes, result.contentType);
    await deps.store.saveAsset({
      id: assetId,
      user_id: job.user_id,
      created_at: deps.now().toISOString(),
      object_name: name,
      content_type: result.contentType,
      job_id: job.id,
    });
    job.status = "succeeded";
    job.asset_id = assetId;
    job.pod_id = deps.config.podName;
    job.error = null;
    await deps.store.saveJob(job);
    if (user) {
      await notify(deps.mailer, {
        kind: "job_ready",
        to: user.email,
        jobId: job.id,
        link: `${deps.config.publicAppUrl}/jobs/${job.id}`,
      });
    }
    return json(200, { ok: true, asset_id: assetId });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "falha";
    job.status = "failed";
    job.error = reason;
    await deps.store.saveJob(job);
    if (user) await notify(deps.mailer, { kind: "job_failed", to: user.email, jobId: job.id, reason });
    if (reason === "pod_not_configured") return json(200, { ok: false, error: reason });
    return json(500, { error: "falha_transitiva" });
  }
}

async function openSession(user: User, deps: Deps): Promise<AppResponse> {
  const exp = deps.now().getTime() + 14 * 24 * 60 * 60 * 1000;
  const session = { id: newId(), user_id: user.id, expires_at: new Date(exp).toISOString() };
  await deps.store.saveSession(session);
  const token = signSession({ sid: session.id, exp }, deps.config.sessionSecret);
  return {
    status: 200,
    body: { id: user.id, email: user.email },
    headers: { "set-cookie": sessionCookie(token, deps, 14 * 24 * 60 * 60) },
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

function sessionCookie(token: string, deps: Deps, maxAge: number): string {
  const secure = deps.config.publicApiUrl.startsWith("https://") ? "; Secure" : "";
  return `invente_session=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

function corsHeaders(origin: string, appUrl: string): Record<string, string> {
  if (!origin || (!ALLOWED_ORIGINS.has(origin) && origin !== appUrl)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
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

function readString(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || !(key in body)) return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function extOf(contentType: string): string {
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}
