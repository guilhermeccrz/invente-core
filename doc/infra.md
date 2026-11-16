# Infra do invente.ai

Projeto `project-639ad7da-da3d-4115-970` (My First Project), conta `guilhermecandido198801@gmail.com`, região `southamerica-east1`. O domínio público é só `invente.ai`. `tupiniquim.ai` não entra.

## Criado

- APIs: Cloud Run, Artifact Registry, Firestore, Secret Manager, Storage, Cloud Tasks e IAM. A API `firebaserules.googleapis.com` também ficou ligada, porque é ela que publica as regras.
- Firestore Native `(default)` em `southamerica-east1`. Regras fecham leitura e escrita do browser. TTLs em `expires_at` de `sessions`, `email_verify` e `password_reset`. Cinco índices compostos de `jobs` e `assets`. O banco não tem documento de usuário, job, asset nem pod.
- Bucket `inventa-media-project-639ad7da-da3d-4115-970`. Acesso público bloqueado, uniform access, soft delete desligado, sem CORS e sem lifecycle. O único objeto é `invente.ai/.keep`.
- Repositório Docker `inventa`.
- Conta `inventa-api`, sem arquivo de chave. Papéis: `datastore.user` no projeto, `storage.objectAdmin` só nesse bucket, `secretAccessor` só em segredo `inventa-*`, `cloudtasks.enqueuer` só na fila `inventa-jobs`, `serviceAccountUser` nela mesma.
- Fila `inventa-jobs`, 3 tentativas, 10 despachos simultâneos, sem URL de destino.
- Segredo `inventa-session-secret`, versão 1. O valor não está no repositório.

## Não foi mexido

O bucket `backoffice-app-assets` continua com `1900-backoffice/`, `commcor-backoffice-titles/`, `display/`, `titan-layer/` e `titanlayer-bucket/`. Nenhum objeto desses prefixos foi lido para alteração nem apagado.

## Fora, de propósito

- Segredos do Google, do Resend e do pod. Ninguém passou o valor.
- Ficha `pods/a6000-sp-1`.
- Cloud Run. Não havia imagem, então `inventa-api` e `inventa-worker` não subiram. O `run.invoker` do worker espera esses serviços.
- Nenhum produto de e-mail do GCP. O envio é no Resend.

## Custo

Cloud Run ainda não existe. Quando o CD publicar, os dois serviços nascem com mínimo 0 e máximo 2, CPU só durante o request. O bucket está com um arquivo mínimo e sem soft delete. Firestore está no free tier.
