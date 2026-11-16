import { randomBytes } from "node:crypto";
import { Firestore, type CollectionReference } from "@google-cloud/firestore";
import type { Asset, Job, Pod, SessionDoc, Store, TokenDoc, TokenKind, User } from "../store.js";

export function firestoreStore(projectId: string): Store {
  const db = new Firestore({ projectId, databaseId: "(default)", ignoreUndefinedProperties: true });
  const users = db.collection("users");
  const sessions = db.collection("sessions");
  const jobs = db.collection("jobs");
  const assets = db.collection("assets");
  const pods = db.collection("pods");
  const ledger = db.collection("token_ledger");
  const tokenCollection = (kind: TokenKind) => db.collection(kind);
  return {
    async findUserByEmail(email) {
      const snap = await users.where("email", "==", email).limit(1).get();
      return snap.empty ? null : (snap.docs[0].data() as User);
    },
    async findUserById(id) {
      return readDoc<User>(users, id);
    },
    async findUserByGoogleSub(sub) {
      const snap = await users.where("google_sub", "==", sub).limit(1).get();
      return snap.empty ? null : (snap.docs[0].data() as User);
    },
    async saveUser(user) {
      await users.doc(user.id).set(user);
    },
    async deleteUser(id) {
      await users.doc(id).delete();
    },
    async saveSession(session) {
      await sessions.doc(session.id).set(session);
    },
    async findSession(id) {
      return readDoc<SessionDoc>(sessions, id);
    },
    async deleteSession(id) {
      await sessions.doc(id).delete();
    },
    async saveToken(kind, doc) {
      await tokenCollection(kind).doc(doc.id).set(doc);
    },
    async findToken(kind, tokenHash) {
      const snap = await tokenCollection(kind).where("token_hash", "==", tokenHash).limit(1).get();
      return snap.empty ? null : (snap.docs[0].data() as TokenDoc);
    },
    async deleteToken(kind, id) {
      await tokenCollection(kind).doc(id).delete();
    },
    async saveJob(job) {
      await jobs.doc(job.id).set(job);
    },
    async findJob(id) {
      return readDoc<Job>(jobs, id);
    },
    async listJobs(userId) {
      const snap = await jobs.where("user_id", "==", userId).orderBy("created_at", "desc").limit(80).get();
      return snap.docs.map((doc) => doc.data() as Job);
    },
    async saveAsset(asset) {
      await assets.doc(asset.id).set(asset);
    },
    async findAsset(id) {
      return readDoc<Asset>(assets, id);
    },
    async listAssets(userId) {
      const snap = await assets.where("user_id", "==", userId).orderBy("created_at", "desc").limit(60).get();
      return snap.docs.map((doc) => doc.data() as Asset);
    },
    async deleteAsset(id) {
      await assets.doc(id).delete();
    },
    async adjustTokens(input) {
      return db.runTransaction(async (tx) => {
        const ref = users.doc(input.userId);
        const snap = await tx.get(ref);
        if (!snap.exists) return { error: "ausente" as const };
        const user = snap.data() as User;
        const balance = user.token_balance ?? 0;
        if (input.delta < 0 && balance + input.delta < 0) return { error: "insuficiente" as const };
        const next = balance + input.delta;
        tx.set(ref, { ...user, token_balance: next }, { merge: true });
        const entryId = randomBytes(16).toString("hex");
        tx.set(ledger.doc(entryId), {
          id: entryId,
          user_id: input.userId,
          created_at: input.at,
          delta: input.delta,
          balance_after: next,
          reason: input.reason,
          job_id: input.jobId,
          note: input.note,
        });
        return { balance: next };
      });
    },
    async savePod(pod) {
      await pods.doc(pod.id).set(pod);
    },
    async listPods() {
      const snap = await pods.get();
      return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<Pod, "id">) }));
    },
    async claimJob(jobId, podId, maxConcurrent) {
      return db.runTransaction(async (tx) => {
        const ref = jobs.doc(jobId);
        const snap = await tx.get(ref);
        if (!snap.exists) return "missing" as const;
        const job = snap.data() as Job;
        if (job.status !== "queued") return "skip" as const;
        const running = await tx.get(jobs.where("pod_id", "==", podId).where("status", "==", "running").limit(maxConcurrent));
        if (running.size >= maxConcurrent) return "busy" as const;
        tx.set(ref, { ...job, status: "running", stage: "preparing", progress: 15, pod_id: podId });
        return "claimed" as const;
      });
    },
  };
}

async function readDoc<T>(collection: CollectionReference, id: string): Promise<T | null> {
  const snap = await collection.doc(id).get();
  return snap.exists ? (snap.data() as T) : null;
}
