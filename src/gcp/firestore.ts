import { Firestore, type CollectionReference } from "@google-cloud/firestore";
import type { Asset, Job, SessionDoc, Store, TokenDoc, TokenKind, User } from "../store.js";

export function firestoreStore(projectId: string): Store {
  const db = new Firestore({ projectId, databaseId: "(default)", ignoreUndefinedProperties: true });
  const users = db.collection("users");
  const sessions = db.collection("sessions");
  const jobs = db.collection("jobs");
  const assets = db.collection("assets");
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
      const snap = await jobs.where("user_id", "==", userId).orderBy("created_at", "desc").limit(50).get();
      return snap.docs.map((doc) => doc.data() as Job);
    },
    async saveAsset(asset) {
      await assets.doc(asset.id).set(asset);
    },
  };
}

async function readDoc<T>(collection: CollectionReference, id: string): Promise<T | null> {
  const snap = await collection.doc(id).get();
  return snap.exists ? (snap.data() as T) : null;
}
