export async function readSecret(projectId: string, name: string): Promise<string> {
  if (!projectId || !name) return "";
  const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: `projects/${projectId}/secrets/${name}/versions/latest` });
  const data = version.payload?.data;
  if (!data) return "";
  return typeof data === "string" ? data : Buffer.from(data).toString("utf8").trim();
}
