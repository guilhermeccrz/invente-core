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
      redirect_uri: `${config.publicAppUrl}/v1/auth/google/callback`,
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

