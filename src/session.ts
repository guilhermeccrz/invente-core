import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SessionPayload = { sid: string; exp: number };

export function signSession(payload: SessionPayload, secret: string): string {
  if (!secret) throw new Error("session secret ausente");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readSession(token: string, secret: string, now = Date.now()): SessionPayload | null {
  if (!secret || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
  if (!payload.sid || payload.exp <= now) return null;
  return payload;
}

export type UploadPayload = { uid: string; exp: number; use: "upload" };

export function signUpload(userId: string, secret: string, exp: number): string {
  if (!secret) throw new Error("session secret ausente");
  const body = Buffer.from(JSON.stringify({ uid: userId, exp, use: "upload" })).toString("base64url");
  const sig = createHmac("sha256", secret).update(`upload.${body}`).digest("base64url");
  return `${body}.${sig}`;
}

export function readUpload(token: string, secret: string, now = Date.now()): UploadPayload | null {
  if (!secret || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(`upload.${body}`).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  let payload: UploadPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString()) as UploadPayload;
  } catch {
    return null;
  }
  if (payload.use !== "upload" || !payload.uid || payload.exp <= now) return null;
  return payload;
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHmac("sha256", "invente-token").update(token).digest("hex");
}
