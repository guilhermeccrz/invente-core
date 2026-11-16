import { loadConfig } from "./config.js";
import { disabledMailer } from "./email/notify.js";
import { resendMailer } from "./email/resend.js";
import { exchangeGoogleCode, runPod } from "./providers.js";
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
  runPod: (input) => runPod(config, input),
  saveMedia: async () => {
    throw new Error("storage_nao_configurado");
  },
  exchangeGoogleCode: (code) => exchangeGoogleCode(config, code),
};

if (config.dataBackend === "firestore") {
  const { firestoreStore } = await import("./gcp/firestore.js");
  const { mediaSaver, taskEnqueuer } = await import("./gcp/clients.js");
  deps.store = firestoreStore(config.projectId);
  deps.enqueue = taskEnqueuer(config);
  deps.saveMedia = mediaSaver(config);
}

await listen(deps, config.port);
console.log(`invente-core ${config.role} na porta ${config.port}`);
