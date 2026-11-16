export function openApiSpec(publicApiUrl: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "invente-core",
      version: "0.1.0",
      description: "API da invente.ai. A geração devolve o job na hora. O cliente consulta GET /v1/jobs/{id} a cada 4 segundos. O progresso anda por etapa e, enquanto gera, pelo tempo decorrido, sem websocket.",
    },
    servers: [
      { url: "/", description: "Este host" },
      { url: publicApiUrl, description: "Produção" },
    ],
    tags: [
      { name: "saude" },
      { name: "auth" },
      { name: "jobs" },
      { name: "worker" },
    ],
    components: {
      securitySchemes: {
        cookie: { type: "apiKey", in: "cookie", name: "invente_session" },
      },
      schemas: {
        erro: {
          type: "object",
          properties: { error: { type: "string" } },
        },
        item: {
          type: "object",
          required: ["workflow"],
          properties: {
            kind: { type: "string", enum: ["image", "video"] },
            workflow: { type: "string" },
            prompt: { type: "string", maxLength: 2000 },
            seed: { type: "integer" },
            image_asset_id: { type: "string", nullable: true },
            video_asset_id: { type: "string", nullable: true },
          },
        },
        credenciais: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
          },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          tags: ["saude"],
          summary: "Saúde do processo",
          responses: { "200": { description: "ok e o papel api ou worker" } },
        },
      },
      "/v1/auth/register": {
        post: {
          tags: ["auth"],
          summary: "Cria a conta e pede confirmação pelo Resend",
          requestBody: jsonBody("#/components/schemas/credenciais"),
          responses: {
            "201": { description: "Conta criada" },
            "409": { description: "E-mail já usado" },
            "503": { description: "Resend não configurado" },
          },
        },
      },
      "/v1/auth/verify": {
        post: {
          tags: ["auth"],
          summary: "Confirma o e-mail",
          requestBody: jsonBody({ type: "object", required: ["token"], properties: { token: { type: "string" } } }),
          responses: { "200": { description: "Confirmado" }, "400": { description: "Token inválido" } },
        },
      },
      "/v1/auth/login": {
        post: {
          tags: ["auth"],
          summary: "Entra com e-mail e senha",
          requestBody: jsonBody("#/components/schemas/credenciais"),
          responses: {
            "200": { description: "Cookie invente_session" },
            "401": { description: "Credenciais inválidas" },
            "403": { description: "E-mail não confirmado" },
          },
        },
      },
      "/v1/auth/logout": {
        post: {
          tags: ["auth"],
          summary: "Encerra a sessão",
          responses: { "204": { description: "Cookie apagado" } },
        },
      },
      "/v1/auth/forgot": {
        post: {
          tags: ["auth"],
          summary: "Pede o link de senha nova",
          requestBody: jsonBody({ type: "object", required: ["email"], properties: { email: { type: "string" } } }),
          responses: { "202": { description: "Aceito, exista ou não a conta" } },
        },
      },
      "/v1/auth/reset": {
        post: {
          tags: ["auth"],
          summary: "Grava a senha nova",
          requestBody: jsonBody({
            type: "object",
            required: ["token", "password"],
            properties: { token: { type: "string" }, password: { type: "string", minLength: 8 } },
          }),
          responses: { "200": { description: "Senha trocada" }, "400": { description: "Token inválido" } },
        },
      },
      "/v1/auth/google/start": {
        get: {
          tags: ["auth"],
          summary: "Redireciona para o Google",
          responses: { "302": { description: "Login Google" }, "503": { description: "Client OAuth ausente" } },
        },
      },
      "/v1/auth/google/callback": {
        get: {
          tags: ["auth"],
          summary: "Volta do Google e abre a sessão",
          parameters: [
            { name: "code", in: "query", schema: { type: "string" } },
            { name: "state", in: "query", schema: { type: "string" } },
          ],
          responses: { "302": { description: "Volta para o site" }, "400": { description: "State inválido" } },
        },
      },
      "/v1/me": {
        get: {
          tags: ["auth"],
          summary: "Conta da sessão",
          security: [{ cookie: [] }],
          responses: { "200": { description: "id e e-mail" }, "401": { description: "Sem sessão" } },
        },
      },
      "/v1/gallery": {
        get: {
          tags: ["jobs"],
          summary: "Galeria da conta. A URL assinada vale 15 minutos.",
          security: [{ cookie: [] }],
          parameters: [{ name: "kind", in: "query", schema: { type: "string", enum: ["image", "video"] } }],
          responses: { "200": { description: "Itens da galeria" }, "401": { description: "Sem sessão" } },
        },
      },
      "/v1/gallery/{id}": {
        delete: {
          tags: ["jobs"],
          summary: "Remove um item da galeria e o arquivo no bucket",
          security: [{ cookie: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "Removido" }, "404": { description: "Não encontrado" } },
        },
      },
      "/v1/workflows": {
        get: {
          tags: ["jobs"],
          summary: "Catálogo ligado neste momento",
          responses: { "200": { description: "Interseção dos fluxos do código com os pods enabled" } },
        },
      },
      "/v1/generate": {
        post: {
          tags: ["jobs"],
          summary: "Enfileira até 4 itens e devolve os jobs na hora",
          security: [{ cookie: [] }],
          requestBody: jsonBody({
            type: "object",
            required: ["items"],
            properties: {
              items: {
                type: "array",
                maxItems: 4,
                items: { $ref: "#/components/schemas/item" },
              },
            },
          }),
          responses: {
            "202": { description: "Jobs na fila. Consulte cada id a cada poll_after_ms." },
            "409": { description: "Workflow sem pod" },
            "429": { description: "Cota ou fila cheia" },
          },
        },
      },
      "/v1/jobs": {
        post: {
          tags: ["jobs"],
          summary: "Enfileira uma geração. O mesmo contrato de um item.",
          security: [{ cookie: [] }],
          requestBody: jsonBody({
            type: "object",
            required: ["prompt"],
            properties: {
              prompt: { type: "string", maxLength: 2000 },
              workflow: { type: "string", enum: ["zimage_t2i", "flux2_t2i", "qwen_image_2_1_t2i", "minimax_i2v", "wan_animate"] },
            },
          }),
          responses: { "202": { description: "Job na fila" }, "401": { description: "Sem sessão" } },
        },
        get: {
          tags: ["jobs"],
          summary: "Lista os jobs da conta",
          security: [{ cookie: [] }],
          responses: { "200": { description: "Lista" }, "401": { description: "Sem sessão" } },
        },
      },
      "/v1/jobs/{id}": {
        get: {
          tags: ["jobs"],
          summary: "Lê um job da conta",
          security: [{ cookie: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Job com stage, progress e, se done, result_url por 15 minutos" },
            "404": { description: "Não encontrado" },
          },
        },
      },
      "/v1/tasks/jobs": {
        post: {
          tags: ["worker"],
          summary: "Executa um job. Só o serviço privado, chamado pela fila.",
          parameters: [
            {
              name: "X-CloudTasks-QueueName",
              in: "header",
              required: true,
              schema: { type: "string", example: "inventa-jobs" },
            },
          ],
          requestBody: jsonBody({ type: "object", required: ["jobId"], properties: { jobId: { type: "string" } } }),
          responses: {
            "200": { description: "Concluído, ignorado ou pod não configurado" },
            "403": { description: "Fila inválida" },
            "500": { description: "Falha transitória, a fila tenta de novo" },
          },
        },
      },
    },
  };
}

function jsonBody(schema: unknown) {
  return {
    required: true,
    content: { "application/json": { schema } },
  };
}

export const docsHtml = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>invente-core</title>
  <link rel="stylesheet" href="/docs/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui" });
  </script>
</body>
</html>`;
