import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/password.js";

const project = process.env.GOOGLE_CLOUD_PROJECT || "project-639ad7da-da3d-4115-970";
const email = (process.env.ACCOUNT_EMAIL || "").trim().toLowerCase();
const password = process.env.ACCOUNT_PASSWORD || "";
const balance = Number(process.env.ACCOUNT_TOKENS || "");
if (!email.includes("@") || password.length < 8 || !Number.isInteger(balance) || balance < 0) {
  console.error("Use ACCOUNT_EMAIL, ACCOUNT_PASSWORD e ACCOUNT_TOKENS.");
  process.exit(1);
}

const accessToken = (process.env.ACCESS_TOKEN || execFileSync(process.env.GCLOUD || "gcloud.cmd", ["auth", "print-access-token"], { encoding: "utf8", shell: true })).trim();
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

const found = await firestore("POST", `${base}:runQuery`, {
  structuredQuery: {
    from: [{ collectionId: "users" }],
    where: { fieldFilter: { field: { fieldPath: "email" }, op: "EQUAL", value: { stringValue: email } } },
    limit: 1,
  },
});
const hit = Array.isArray(found) ? found.find((row) => row.document?.name) : null;
const existingName = hit?.document?.name as string | undefined;
const previous = hit?.document?.fields || {};
const id = existingName ? existingName.split("/").pop() || "" : randomBytes(16).toString("hex");
const now = new Date().toISOString();
const createdAt = previous.created_at?.stringValue || now;
const previousBalance = Number(previous.token_balance?.integerValue || 0);
await firestore("PATCH", `${base}/users/${id}`, {
  fields: {
    id: { stringValue: id },
    email: { stringValue: email },
    password_hash: { stringValue: await hashPassword(password) },
    google_sub: previous.google_sub?.stringValue ? { stringValue: previous.google_sub.stringValue } : { nullValue: null },
    email_verified: { booleanValue: true },
    created_at: { stringValue: createdAt },
    token_balance: { integerValue: String(balance) },
  },
});
const entryId = randomBytes(16).toString("hex");
const delta = balance - previousBalance;
await firestore("PATCH", `${base}/token_ledger/${entryId}`, {
  fields: {
    id: { stringValue: entryId },
    user_id: { stringValue: id },
    created_at: { stringValue: now },
    delta: { integerValue: String(delta) },
    balance_after: { integerValue: String(balance) },
    reason: { stringValue: "credito_manual" },
    job_id: { nullValue: null },
    note: { stringValue: "ajuste manual" },
  },
});
console.log(JSON.stringify({ id, email, token_balance: balance, delta }));

async function firestore(method: string, url: string, body: unknown) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-goog-user-project": project,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`firestore ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
