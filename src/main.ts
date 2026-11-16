import { loadConfig } from "./config.js";
import { executeComfy } from "./comfy.js";
import { disabledMailer } from "./email/notify.js";
import { resendMailer } from "./email/resend.js";
import { exchangeGoogleCode } from "./providers.js";
import { readSecret } from "./secrets.js";
import { listen } from "./server.js";
import { memoryStore } from "./store.js";
import type { Deps } from "./app.js";

const config = loadConfig();

const deps: Deps = {
  config,
  store: memoryStore(),
  mailer: config.resendApiKey ? resendMailer(config.resendApiKey, config.emailFrom) : disabledMailer(),
  now: () => new Date(),
  enqueue: async () => "skipped",
  runPod: (input) => executeComfy(input),
  readPodToken: async (name) => (config.dataBackend === "firestore" ? readSecret(config.projectId, name) : config.podToken),
  loadMedia: async () => {
    throw new Error("storage_nao_configurado");
  },
  signMedia: async () => {
    throw new Error("storage_nao_configurado");
  },
  deleteMedia: async () => {
    throw new Error("storage_nao_configurado");
  },
  saveMedia: async () => {
    throw new Error("storage_nao_configurado");
  },
  exchangeGoogleCode: (code) => exchangeGoogleCode(config, code),
};

if (config.dataBackend === "firestore") {
  const { firestoreStore } = await import("./gcp/firestore.js");
  const { mediaDeleter, mediaLoader, mediaSaver, mediaSigner, taskEnqueuer } = await import("./gcp/clients.js");
  deps.store = firestoreStore(config.projectId);
  deps.enqueue = taskEnqueuer(config);
  deps.saveMedia = mediaSaver(config);
  deps.loadMedia = mediaLoader(config);
  deps.signMedia = mediaSigner(config);
  deps.deleteMedia = mediaDeleter(config);
}

await listen(deps, config.port);
console.log(`invente-core ${config.role} na porta ${config.port}`);
