export type User = {
  id: string;
  email: string;
  password_hash: string | null;
  google_sub: string | null;
  email_verified: boolean;
  created_at: string;
  token_balance: number;
};

export type SessionDoc = { id: string; user_id: string; expires_at: string };
export type TokenDoc = { id: string; user_id: string; token_hash: string; expires_at: string };
export type JobStatus = "queued" | "running" | "done" | "error";
export type JobStage = "queued" | "preparing" | "generating" | "saving" | "done" | "error";
export type MediaKind = "image" | "video";

export type Job = {
  id: string;
  user_id: string;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  timeout_seconds: number;
  prompt: string;
  workflow: string;
  kind: MediaKind;
  seed: number;
  image_asset_id: string | null;
  video_asset_id: string | null;
  pod_id: string | null;
  asset_id: string | null;
  error: string | null;
  pod_path: string | null;
  mode: "auto" | "manual";
  token_cost: number;
  tokens_state: "held" | "spent" | "refunded";
};

export type Asset = {
  id: string;
  user_id: string;
  created_at: string;
  object_name: string;
  content_type: string;
  job_id: string;
  kind: MediaKind;
  workflow: string;
  prompt: string;
  mode: "auto" | "manual";
};

export type TokenReason = "geracao" | "estorno" | "credito_manual";

export type TokenAdjustment = {
  userId: string;
  delta: number;
  at: string;
  reason: TokenReason;
  jobId: string | null;
  note: string;
};

export type Pod = {
  id: string;
  name: string;
  enabled: boolean;
  base_url: string;
  token_secret: string;
  max_concurrent: number;
  workflows: string[];
  image_timeout_seconds: number;
  video_timeout_seconds: number;
};

export type TokenKind = "email_verify" | "password_reset";
export type Claim = "claimed" | "busy" | "skip" | "missing";

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
  findAsset(id: string): Promise<Asset | null>;
  listAssets(userId: string): Promise<Asset[]>;
  deleteAsset(id: string): Promise<void>;
  adjustTokens(input: TokenAdjustment): Promise<{ balance: number } | { error: "insuficiente" | "ausente" }>;
  savePod(pod: Pod): Promise<void>;
  listPods(): Promise<Pod[]>;
  claimJob(jobId: string, podId: string, maxConcurrent: number): Promise<Claim>;
};

export function memoryStore(): Store {
  const users: User[] = [];
  const sessions: SessionDoc[] = [];
  const tokens: Record<TokenKind, TokenDoc[]> = { email_verify: [], password_reset: [] };
  const jobs: Job[] = [];
  const assets: Asset[] = [];
  const pods: Pod[] = [];
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
      return jobs.filter((job) => job.user_id === userId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 80);
    },
    async saveAsset(asset) {
      const index = assets.findIndex((item) => item.id === asset.id);
      if (index >= 0) assets[index] = asset;
      else assets.push(asset);
    },
    async findAsset(id) {
      return assets.find((asset) => asset.id === id) ?? null;
    },
    async listAssets(userId) {
      return assets.filter((asset) => asset.user_id === userId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 60);
    },
    async deleteAsset(id) {
      const index = assets.findIndex((asset) => asset.id === id);
      if (index >= 0) assets.splice(index, 1);
    },
    async adjustTokens(input) {
      const user = users.find((item) => item.id === input.userId);
      if (!user) return { error: "ausente" };
      const balance = user.token_balance ?? 0;
      if (input.delta < 0 && balance + input.delta < 0) return { error: "insuficiente" };
      user.token_balance = balance + input.delta;
      return { balance: user.token_balance };
    },
    async savePod(pod) {
      const index = pods.findIndex((item) => item.id === pod.id);
      if (index >= 0) pods[index] = pod;
      else pods.push(pod);
    },
    async listPods() {
      return pods.map((pod) => ({ ...pod, workflows: [...pod.workflows] }));
    },
    async claimJob(jobId, podId, maxConcurrent) {
      const job = jobs.find((item) => item.id === jobId);
      if (!job) return "missing";
      if (job.status !== "queued") return "skip";
      const running = jobs.filter((item) => item.pod_id === podId && item.status === "running").length;
      if (running >= maxConcurrent) return "busy";
      job.status = "running";
      job.stage = "preparing";
      job.progress = 15;
      job.pod_id = podId;
      return "claimed";
    },
  };
}
