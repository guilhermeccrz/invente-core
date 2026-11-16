import type { Config } from "./config.js";

export async function exchangeGoogleCode(config: Config, code: string): Promise<{ sub: string; email: string }> {
  if (!config.googleClientId || !config.googleClientSecret) throw new Error("google_nao_configurado");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: `${config.publicApiUrl}/v1/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) throw new Error("google_token_invalido");
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("google_token_invalido");
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!profileResponse.ok) throw new Error("google_perfil_invalido");
  const profile = (await profileResponse.json()) as { sub?: string; email?: string };
  if (!profile.sub || !profile.email) throw new Error("google_perfil_invalido");
  return { sub: profile.sub, email: profile.email };
}

export async function runPod(config: Config, input: { workflow: string; prompt: string; jobId: string }) {
  if (!config.podBaseUrl || !config.podToken) throw new Error("pod_not_configured");
  const response = await fetch(`${config.podBaseUrl}/invente/generate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.podToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workflow: input.workflow, prompt: input.prompt, job_id: input.jobId }),
  });
  if (!response.ok) throw new Error("pod_indisponivel");
  const payload = (await response.json()) as { image_base64?: string; content_type?: string };
  if (!payload.image_base64) throw new Error("pod_sem_imagem");
  return {
    bytes: Buffer.from(payload.image_base64, "base64"),
    contentType: payload.content_type || "image/png",
  };
}
