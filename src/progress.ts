export const POLL_AFTER_MS = 4000;

export function generatingProgress(startedAtMs: number, nowMs: number, timeoutSeconds: number): number {
  const elapsed = Math.max(0, (nowMs - startedAtMs) / 1000);
  const span = Math.max(1, timeoutSeconds);
  const ratio = Math.min(1, elapsed / span);
  return Math.min(90, 35 + Math.floor(ratio * 55));
}
