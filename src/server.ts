import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handle, type AppRequest, type Deps } from "./app.js";

export function listen(deps: Deps, port: number) {
  const server = createServer((req, res) => {
    void onRequest(req, res, deps);
  });
  return new Promise<ReturnType<typeof createServer>>((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

async function onRequest(req: IncomingMessage, res: ServerResponse, deps: Deps) {
  const url = new URL(req.url || "/", "http://localhost");
  const body = await readBody(req);
  const response = await handle(
    {
      method: req.method || "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: lowerHeaders(req.headers),
      body,
      cookies: parseCookies(req.headers.cookie),
    } satisfies AppRequest,
    deps,
  );
  res.writeHead(response.status, response.headers);
  res.end(response.body === undefined ? "" : JSON.stringify(response.body));
}

function lowerHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
  }
  return out;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) cookies[name] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}
