export type Role = "api" | "worker";
export type DataBackend = "memory" | "firestore";

export type Config = {
  role: Role;
  port: number;
  projectId: string;
  publicApiUrl: string;
  publicAppUrl: string;
  mediaBucket: string;
  mediaPrefix: string;
  tasksLocation: string;
  tasksQueue: string;
  tasksWorkerUrl: string;
  tasksInvokerEmail: string;
  sessionSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  resendApiKey: string;
  emailFrom: string;
  podBaseUrl: string;
  podToken: string;
  podName: string;
  dataBackend: DataBackend;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const role = env.ROLE === "worker" ? "worker" : "api";
  const backend = env.DATA_BACKEND === "firestore" ? "firestore" : "memory";
  return {
    role,
    port: Number(env.PORT || 8080),
    projectId: env.GOOGLE_CLOUD_PROJECT || "",
    publicApiUrl: trimSlash(env.PUBLIC_API_URL || "http://localhost:8080"),
    publicAppUrl: trimSlash(env.PUBLIC_APP_URL || "http://localhost:3000"),
    mediaBucket: env.MEDIA_BUCKET || "",
    mediaPrefix: normalizePrefix(env.MEDIA_PREFIX || "invente.ai/"),
    tasksLocation: env.TASKS_LOCATION || "southamerica-east1",
    tasksQueue: env.TASKS_QUEUE || "inventa-jobs",
    tasksWorkerUrl: env.TASKS_WORKER_URL || "",
    tasksInvokerEmail: env.TASKS_INVOKER_EMAIL || "",
    sessionSecret: env.SESSION_SECRET || "",
    googleClientId: env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
    resendApiKey: env.RESEND_API_KEY || "",
    emailFrom: env.MAIL_FROM || env.EMAIL_FROM || "Invente.AI <support@invente.ai>",
    podBaseUrl: trimSlash(env.POD_BASE_URL || ""),
    podToken: env.POD_TOKEN || "",
    podName: env.POD_NAME || "a6000-sp-1",
    dataBackend: backend,
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePrefix(value: string): string {
  const clean = value.replace(/^\/+/, "").replace(/\\/g, "/");
  return clean.endsWith("/") ? clean : `${clean}/`;
}
