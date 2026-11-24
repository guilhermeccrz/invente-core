import { Storage } from "@google-cloud/storage";
import { CloudTasksClient } from "@google-cloud/tasks";
import type { Config } from "../config.js";
import { assertSafeObjectName } from "../mediaPath.js";

function bucketOf(config: Config) {
  const storage = new Storage({ projectId: config.projectId });
  return storage.bucket(config.mediaBucket);
}

export function mediaSaver(config: Config) {
  const bucket = bucketOf(config);
  return async (name: string, bytes: Buffer, contentType: string) => {
    assertSafeObjectName(name, config.mediaPrefix);
    await bucket.file(name).save(bytes, { contentType, resumable: false });
  };
}

export function mediaLoader(config: Config) {
  const bucket = bucketOf(config);
  return async (name: string) => {
    assertSafeObjectName(name, config.mediaPrefix);
    const [bytes] = await bucket.file(name).download();
    return bytes;
  };
}

export function mediaDeleter(config: Config) {
  const bucket = bucketOf(config);
  return async (name: string) => {
    assertSafeObjectName(name, config.mediaPrefix);
    await bucket.file(name).delete({ ignoreNotFound: true });
  };
}

export function mediaSigner(config: Config) {
  const bucket = bucketOf(config);
  return async (name: string) => {
    assertSafeObjectName(name, config.mediaPrefix);
    const [url] = await bucket.file(name).getSignedUrl({ action: "read", expires: Date.now() + 15 * 60 * 1000 });
    return url;
  };
}

export function taskEnqueuer(config: Config) {
  const client = new CloudTasksClient();
  return async (jobId: string, delaySeconds = 0): Promise<"sent" | "skipped"> => {
    if (!config.tasksWorkerUrl || !config.projectId) return "skipped";
    const parent = client.queuePath(config.projectId, config.tasksLocation, config.tasksQueue);
    const scheduleTime = delaySeconds > 0 ? { seconds: Math.floor(Date.now() / 1000) + delaySeconds } : undefined;
    await client.createTask({
      parent,
      task: {
        scheduleTime,
        dispatchDeadline: { seconds: 1800 },
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
