import { Storage } from "@google-cloud/storage";
import { CloudTasksClient } from "@google-cloud/tasks";
import type { Config } from "../config.js";
import { assertSafeObjectName } from "../mediaPath.js";

export function mediaSaver(config: Config) {
  const storage = new Storage({ projectId: config.projectId });
  const bucket = storage.bucket(config.mediaBucket);
  return async (name: string, bytes: Buffer, contentType: string) => {
    assertSafeObjectName(name, config.mediaPrefix);
    await bucket.file(name).save(bytes, { contentType, resumable: false });
  };
}

export function taskEnqueuer(config: Config) {
  const client = new CloudTasksClient();
  return async (jobId: string): Promise<"sent" | "skipped"> => {
    if (!config.tasksWorkerUrl || !config.projectId) return "skipped";
    const parent = client.queuePath(config.projectId, config.tasksLocation, config.tasksQueue);
    await client.createTask({
      parent,
      task: {
        httpRequest: {
          httpMethod: "POST",
          url: config.tasksWorkerUrl,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify({ jobId })).toString("base64"),
          oidcToken: config.tasksInvokerEmail ? { serviceAccountEmail: config.tasksInvokerEmail } : undefined,
        },
      },
    });
    return "sent";
  };
}
