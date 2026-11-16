import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const files: Record<string, string> = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "text/javascript; charset=utf-8",
};

export function swaggerFile(name: string): { type: string; body: string } | null {
  const type = files[name];
  if (!type) return null;
  const dir = path.dirname(require.resolve("swagger-ui-dist/package.json"));
  return { type, body: readFileSync(path.join(dir, name), "utf8") };
}
