# O que já está feito e o que vem depois

Registro de 16 de novembro de 2026. O serviço é o `invente-core`. O site é o `tupiniquim.ai`, publicado como invente.ai.

## Serviço

A API e o worker sobem no Cloud Run, em `southamerica-east1`, com a conta `inventa-api`. O banco é o Firestore. Os arquivos ficam no bucket privado, só debaixo de `invente.ai/users/{userId}/`. O pod `a6000-sp-1` executa o Comfy. O browser não fala com o pod: o site chama `/v1` no Next, e o Next encaminha para a API.

Os cinco modelos geraram de verdade: Z-Image, Qwen, Flux 2, MiniMax e Wan Animate. O Flux precisou de prazo maior na carga fria e de não empilhar outro prompt enquanto o modelo ainda entra na memória. O guia disso está em `doc/troubleshooting-modelos.md`.

O preço é por token. Uma variação é um job, com semente própria, e o débito é o custo do modelo vezes a quantidade. A dimensão da imagem (1:1, 3:2, 2:3, 16:9, 9:16) é escrita nos nós de tamanho que o grafo atual já tem. Não foi preciso mudar o workflow no pod.

Apagar uma criação não tira o arquivo na hora. O item vai para a lixeira por 2 dias e pode ser restaurado. Passou o prazo, some do bucket.

## Site

Entrar e criar conta levam ao `/studio`. A home mostra o prompt, mas não gera. No studio logado ficam visão geral, imagem, vídeo e a galeria da conta. Não há página de planos.

O prompt do studio escolhe o modelo, a dimensão, a quantidade de variações e a referência. A referência é um cartão: o clique abre um modal para arrastar um arquivo ou escolher uma criação já feita. O arquivo sobe para o bucket do usuário e a galeria separa isso na aba Referência.

Em cada criação dá para baixar, usar como referência, copiar o prompt e apagar. A aba Lixeira mostra o que foi apagado.

O login com Google tem botão, mas o client OAuth ainda não existe. Faltam `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`, com redirect `https://invente.ai/v1/auth/google/callback`.

## Lixeira no prazo, sem esperar alguém abrir a galeria

Abrir a galeria já apaga o que daquela conta passou de 2 dias. Isso não alcança uma conta que ninguém abre.

O worker agora tem `POST /v1/tasks/trash`. Ele só responde se o papel do processo é `worker` e se o pedido traz `x-inventa-cron: lixeira` ou o cabeçalho da fila `inventa-jobs`. A rota lista os assets com `deleted_at` anterior ao corte, apaga o objeto e o documento. No máximo 200 por chamada.

O agendamento é um Cloud Scheduler, um job por dia, dentro da franquia gratuita. Ele chama o worker privado com a conta `inventa-api`. O comando, depois que a revisão com essa rota estiver no ar:

```bash
gcloud services enable cloudscheduler.googleapis.com --project project-639ad7da-da3d-4115-970
gcloud scheduler jobs create http inventa-lixeira \
  --project project-639ad7da-da3d-4115-970 \
  --location southamerica-east1 \
  --schedule "0 8 * * *" \
  --time-zone America/Sao_Paulo \
  --uri "https://inventa-worker-1083775665503.southamerica-east1.run.app/v1/tasks/trash" \
  --http-method POST \
  --headers "x-inventa-cron=lixeira" \
  --oidc-service-account-email inventa-api@project-639ad7da-da3d-4115-970.iam.gserviceaccount.com \
  --oidc-token-audience "https://inventa-worker-1083775665503.southamerica-east1.run.app"
```

Essa revisão ainda não está publicada. A que está no ar apaga na hora e não tem essa rota.

## Próximos passos

- Publicar no Cloud Run a revisão com dimensão, variações, lixeira e a rota da limpeza. Sem isso o site novo fala com um serviço antigo.
- Criar o job `inventa-lixeira` no Cloud Scheduler com o comando acima.
- Criar o client Web do Google e gravar os dois segredos `inventa-google-client-id` e `inventa-google-client-secret`.
- Apontar `api.invente.ai` no Cloudflare quando for a hora. Enquanto o DNS não existe, o site usa a URL do Cloud Run.
- Confirmar o domínio `invente.ai` no Resend para o e-mail de cadastro sair de `support@invente.ai`.
- Pagamento continua fora. O saldo entra na conta à mão.
