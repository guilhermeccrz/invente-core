export type User = {
  id: string;
  email: string;
  password_hash: string | null;
  google_sub: string | null;
  email_verified: boolean;
  created_at: string;
};

export type SessionDoc = { id: string; user_id: string; expires_at: string };
export type TokenDoc = { id: string; user_id: string; token_hash: string; expires_at: string };
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export type Job = {
  id: string;
  user_id: string;
  status: JobStatus;
  created_at: string;
  prompt: string;
  workflow: string;
  pod_id: string | null;
  asset_id: string | null;
  error: string | null;
};

export type Asset = {
  id: string;
  user_id: string;
  created_at: string;
  object_name: string;
  content_type: string;
  job_id: string;
};

export type TokenKind = "email_verify" | "password_reset";

export type Store = {
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  findUserByGoogleSub(sub: string): Promise<User | null>;
  saveUser(user: User): Promise<void>;
  deleteUser(id: string): Promise<void>;
  saveSession(session: SessionDoc): Promise<void>;
  findSession(id: string): Promise<SessionDoc | null>;
  deleteSession(id: string): Promise<void>;
  saveToken(kind: TokenKind, doc: TokenDoc): Promise<void>;
  findToken(kind: TokenKind, tokenHash: string): Promise<TokenDoc | null>;
  deleteToken(kind: TokenKind, id: string): Promise<void>;
  saveJob(job: Job): Promise<void>;
  findJob(id: string): Promise<Job | null>;
  listJobs(userId: string): Promise<Job[]>;
  saveAsset(asset: Asset): Promise<void>;
};

export function memoryStore(): Store {
  const users: User[] = [];
  const sessions: SessionDoc[] = [];
  const tokens: Record<TokenKind, TokenDoc[]> = { email_verify: [], password_reset: [] };
  const jobs: Job[] = [];
  const assets: Asset[] = [];
  return {
    async findUserByEmail(email) {
      return users.find((user) => user.email === email) ?? null;
    },
    async findUserById(id) {
      return users.find((user) => user.id === id) ?? null;
    },
    async findUserByGoogleSub(sub) {
      return users.find((user) => user.google_sub === sub) ?? null;
    },
    async saveUser(user) {
      const index = users.findIndex((item) => item.id === user.id);
      if (index >= 0) users[index] = user;
      else users.push(user);
    },
    async deleteUser(id) {
      const index = users.findIndex((user) => user.id === id);
      if (index >= 0) users.splice(index, 1);
    },
    async saveSession(session) {
      sessions.push(session);
    },
    async findSession(id) {
      return sessions.find((session) => session.id === id) ?? null;
    },
    async deleteSession(id) {
      const index = sessions.findIndex((session) => session.id === id);
      if (index >= 0) sessions.splice(index, 1);
    },
    async saveToken(kind, doc) {
      tokens[kind].push(doc);
    },
    async findToken(kind, tokenHash) {
      return tokens[kind].find((doc) => doc.token_hash === tokenHash) ?? null;
    },
    async deleteToken(kind, id) {
      const index = tokens[kind].findIndex((doc) => doc.id === id);
      if (index >= 0) tokens[kind].splice(index, 1);
    },
    async saveJob(job) {
      const index = jobs.findIndex((item) => item.id === job.id);
      if (index >= 0) jobs[index] = job;
      else jobs.push(job);
    },
    async findJob(id) {
      return jobs.find((job) => job.id === id) ?? null;
    },
    async listJobs(userId) {
      return jobs.filter((job) => job.user_id === userId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    },
    async saveAsset(asset) {
      assets.push(asset);
    },
  };
}
