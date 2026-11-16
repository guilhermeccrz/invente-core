export type ComfyNode = { class_type: string; inputs: Record<string, unknown> };
export type ComfyPrompt = Record<string, ComfyNode>;

export type PodResult = {
  bytes: Buffer;
  contentType: string;
  podPath: string;
};

export type PodRun = {
  baseUrl: string;
  token: string;
  prompt: ComfyPrompt;
  timeoutMs: number;
  outputNode?: string | null;
  onAccepted?: () => Promise<void>;
};

type ComfyFile = { filename: string; subfolder?: string; type?: string };
type FetchLike = typeof fetch;

const POLL_MS = 4000;

export async function uploadToComfy(baseUrl: string, token: string, bytes: Buffer, filename: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)]), filename);
  form.append("overwrite", "true");
  form.append("type", "input");
  const response = await fetchImpl(`${trim(baseUrl)}/upload/image`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error("pod_not_configured");
  if (!response.ok) throw new Error("pod_indisponivel");
  const payload = (await response.json()) as { name?: string; subfolder?: string };
  if (!payload.name) throw new Error("pod_indisponivel");
  return payload.subfolder ? `${payload.subfolder}/${payload.name}` : payload.name;
}

export async function executeComfy(input: PodRun & { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<PodResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const base = trim(input.baseUrl);
  const accepted = await fetchImpl(`${base}/prompt`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: input.prompt }),
    signal: AbortSignal.timeout(60_000),
  });
  if (accepted.status === 401 || accepted.status === 403) throw new Error("pod_not_configured");
  const acceptedText = await accepted.text();
  if (!accepted.ok) {
    if (accepted.status >= 500) throw new Error("pod_indisponivel");
    throw new Error(`comfy_rejeitou:${brief(acceptedText)}`);
  }
  const queued = JSON.parse(acceptedText) as { prompt_id?: string; node_errors?: Record<string, unknown> };
  if (!queued.prompt_id || (queued.node_errors && Object.keys(queued.node_errors).length > 0)) {
    throw new Error(`comfy_rejeitou:${brief(acceptedText)}`);
  }
  await input.onAccepted?.();
  const started = now();
  try {
    while (now() - started < input.timeoutMs) {
      await sleep(POLL_MS);
      let history: Response;
      try {
        history = await fetchImpl(`${base}/history/${queued.prompt_id}`, {
          headers: { authorization: `Bearer ${input.token}` },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (isWait(error)) continue;
        throw error;
      }
      if (history.status === 401 || history.status === 403) throw new Error("pod_not_configured");
      if (!history.ok) throw new Error("pod_indisponivel");
      const entry = historyEntry(await history.json(), queued.prompt_id);
      if (entry?.status?.status_str === "error") throw new Error(`comfy_falhou:${brief(JSON.stringify(entry.status.messages || ""))}`);
      const file = pickFile(entry?.outputs, input.outputNode);
      if (file && (entry?.status?.completed || entry?.status?.status_str === "success")) return download(base, input.token, file, fetchImpl);
    }
    throw new Error("comfy_timeout");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (!reason.startsWith("comfy_falhou")) await stopPrompt(base, input.token, queued.prompt_id, fetchImpl);
    throw error;
  }
}

function isWait(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "TimeoutError" || name === "AbortError";
}

async function stopPrompt(base: string, token: string, promptId: string, fetchImpl: FetchLike): Promise<void> {
  await fetchImpl(`${base}/interrupt`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt_id: promptId }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

async function download(base: string, token: string, file: ComfyFile, fetchImpl: FetchLike): Promise<PodResult> {
  const url = new URL(`${base}/view`);
  url.searchParams.set("filename", file.filename);
  url.searchParams.set("subfolder", file.subfolder || "");
  url.searchParams.set("type", file.type || "output");
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error("pod_indisponivel");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("pod_sem_arquivo");
  const header = response.headers.get("content-type") || "";
  return { bytes, contentType: header || contentTypeOf(file.filename), podPath: podPath(file) };
}

function historyEntry(payload: unknown, promptId: string): { outputs?: Record<string, unknown>; status?: { completed?: boolean; status_str?: string; messages?: unknown } } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const entry = (record[promptId] && typeof record[promptId] === "object" ? record[promptId] : record) as {
    outputs?: Record<string, unknown>;
    status?: { completed?: boolean; status_str?: string; messages?: unknown };
  };
  if (!entry.outputs && !entry.status) return null;
  return entry;
}

function pickFile(outputs: Record<string, unknown> | undefined, outputNode?: string | null): ComfyFile | null {
  if (!outputs) return null;
  const order = outputNode && outputs[outputNode] ? [outputNode, ...Object.keys(outputs).filter((id) => id !== outputNode)] : Object.keys(outputs);
  for (const id of order) {
    const entry = outputs[id];
    if (!entry || typeof entry !== "object") continue;
    for (const key of ["images", "videos", "gifs"]) {
      const list = (entry as Record<string, unknown>)[key];
      if (!Array.isArray(list)) continue;
      const file = list.find((item) => item && typeof item === "object" && typeof (item as ComfyFile).filename === "string") as ComfyFile | undefined;
      if (file) return file;
    }
  }
  return null;
}

export function podPath(file: ComfyFile): string {
  const folder = file.type === "temp" ? "temp" : "output";
  const sub = file.subfolder ? `${file.subfolder.replace(/^\/+|\/+$/g, "")}/` : "";
  return `/workspace/ComfyUI/${folder}/${sub}${file.filename}`;
}

function contentTypeOf(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "mp4") return "video/mp4";
  if (ext === "webm") return "video/webm";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

function brief(text: string): string {
  return text.replace(/bearer\s+\S+/gi, "bearer").replace(/\s+/g, " ").slice(0, 160);
}

function trim(value: string): string {
  return value.replace(/\/+$/, "");
}
