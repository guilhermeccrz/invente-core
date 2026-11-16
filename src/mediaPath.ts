const BLOCKED = new Set(["1900", "1900-backoffice", "commcor", "commcor-backoffice-titles"]);

export function objectName(prefix: string, userId: string, kind: "image" | "video", assetId: string, ext?: string): string {
  const safePrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const folder = kind === "video" ? "videos" : "images";
  const extension = ext || (kind === "video" ? "mp4" : "png");
  const name = `${safePrefix}users/${assertId(userId)}/${folder}/${assertId(assetId)}.${assertExt(extension)}`;
  assertSafeObjectName(name, safePrefix);
  return name;
}

export function assertSafeObjectName(name: string, prefix: string): void {
  const normalized = name.replace(/\\/g, "/");
  if (normalized !== name || name.includes("..") || name.startsWith("/")) {
    throw new Error("caminho de objeto recusado");
  }
  if (!name.startsWith(prefix)) {
    throw new Error("objeto fora do prefixo invente.ai");
  }
  const segments = name.split("/");
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (BLOCKED.has(lower) || lower.startsWith("1900-") || lower.startsWith("commcor-")) {
      throw new Error("prefixo reservado a outro produto");
    }
  }
}

function assertId(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw new Error("id invalido");
  return value;
}

function assertExt(value: string): string {
  if (!/^[a-z0-9]{2,5}$/.test(value)) throw new Error("extensao invalida");
  return value;
}
