import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error("senha curta");
  const salt = randomBytes(16).toString("base64url");
  const key = (await scrypt(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, encoded] = stored.split("$");
  if (algo !== "scrypt" || !salt || !encoded) return false;
  const key = (await scrypt(password, salt, 32)) as Buffer;
  const expected = Buffer.from(encoded, "base64url");
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}
