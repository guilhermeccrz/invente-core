# O que falta para o serviço

O `infra/CRIAR.MD` do outro repositório está vazio. O serviço implementa o que a infra descreve: API, worker, sessão, Google, jobs, assets e aviso por e-mail. O e-mail sai pelo Resend, em `https://api.resend.com/emails`.

## Colocar no ambiente

Copia `.env.example` para `.env` na máquina local. No Cloud Run o valor entra como referência do Secret Manager, nunca em texto no repositório.

| Variável | Onde arrumar |
| --- | --- |
| `RESEND_API_KEY` | Painel do Resend. Vira o segredo `inventa-resend-api-key` quando a chave existir. |
| `EMAIL_FROM` | Remetente verificado no Resend, no domínio `invente.ai`. |
| `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` | Client Web no console. Origens `https://invente.ai`, `https://www.invente.ai` e `http://localhost:3000`. Redirect `https://api.invente.ai/v1/auth/google/callback`. |
| `POD_BASE_URL` e `POD_TOKEN` | Proxy do pod na porta 8188. Os dois juntos. O worker chama `POST {base}/invente/generate`. |
| `SESSION_SECRET` | Já existe no Secret Manager. No Cloud Run a referência é `inventa-session-secret:latest`. |
| `TASKS_WORKER_URL` | O deploy preenche com a URL do worker depois que ele existir. |

Sem a chave do Resend, cadastro, reset e aviso de job respondem `email_not_configured` e não gravam o usuário. Sem o pod, o job fica `pod_not_configured` e a fila não fica tentando de novo.

## Cloudflare, depois

Ainda não há URL de Cloud Run. Quando o primeiro deploy existir, o DNS de `api.invente.ai` aponta para o host `*.run.app` da `inventa-api`. O primeiro teste pode ser só DNS. O proxy laranja da Cloudflare entra em seguida, com SSL completo. Isso não foi feito agora.

## CI e CD

`npm test` passou localmente: 12 testes. O workflow `ci` roda teste e build nos pull requests. O workflow `cd` faz o mesmo em `main` e só publica a imagem se a variável `CD_ENABLED` do GitHub for `true`.

Para ligar o deploy, ainda faltam, sem chave JSON:

- Pool de Workload Identity do repositório `guilhermeccrz/invente-core`.
- Conta de deploy com permissão de enviar imagem para `inventa` e atualizar os dois serviços Cloud Run.
- Segredos `GCP_WORKLOAD_IDENTITY_PROVIDER` e `GCP_DEPLOYER_SA`.
- Variável `CD_ENABLED=true`.

O script `scripts/deploy.sh` sobe `inventa-api` pública e `inventa-worker` privada, mínimo 0 e máximo 2, com a conta `inventa-api`.
