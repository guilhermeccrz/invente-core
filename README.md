# invente-core

API e worker do Invente.ai. O browser não fala com o ComfyUI. Ele fala com esta API, a fila chama o worker, e o worker chama o pod.

## O que sobe

Uma imagem só. `ROLE=api` é o Cloud Run público `inventa-api`. `ROLE=worker` é o `inventa-worker`, privado, com timeout de 1200 s. Os dois usam a conta `inventa-api`, Firestore Native em `southamerica-east1` e o bucket `inventa-media-project-639ad7da-da3d-4115-970`. Todo objeto fica em `invente.ai/`. Os prefixos `1900` e `commcor` são recusados.

```
browser (invente.ai)
  |  cookie de sessão, via proxy /v1 do front
  v
inventa-api
  |  debita tokens, grava o job, devolve o id
  v
Cloud Tasks  inventa-jobs
  v
inventa-worker
  |  Authorization: Bearer, segredo lido na hora
  v
ComfyUI no pod a6000-sp-1
  |  arquivo
  v
bucket invente.ai/users/{id}/images|videos/{asset}
```

Não há Cloud SQL, Redis, VM nem e-mail do GCP. O e-mail sai pelo Resend. A chave fica no segredo `inventa-resend-api-key`. O remetente é `MAIL_FROM`.

## Pedido de geração

`GET /v1/workflows` devolve o catálogo que algum pod `enabled` realmente aceita, mais o preço de lista.

`POST /v1/generate` recebe até 4 itens. A API confere cota (30 imagens e 5 vídeos por hora, 3 jobs ativos), debita a soma dos tokens e grava cada job como `queued`. A resposta traz o `job_id` na hora. O cliente consulta `GET /v1/jobs/{id}` a cada `poll_after_ms` (4 s). O percentual de `generating` sobe com o tempo até 90 e só chega a 100 quando o arquivo existe. Não há websocket.

Se o worker desiste, e o débito ainda está `held`, os tokens voltam com `reason: estorno`. Sucesso marca `spent`.

## Tokens

Três variáveis, lidas no processo:

| Variável | Hoje | Papel |
| --- | --- | --- |
| `POD_USD_PER_HOUR` | `0.70` | Custo da A6000 |
| `TOKEN_USD` | `0.001` | Preço de lista de 1 token |
| `TOKEN_MARGIN` | `1.5` | Piso sobre o custo de GPU |

A média de segundos veio do histórico do Comfy neste pod em 16 nov 2026. Flux é a média da corrida fria (372 s) e da quente (112 s). Os outros modelos têm uma amostra.

O preço público de comparação, pesquisado na mesma data:

- Z-Image Turbo na fal fica em cerca de US$ 0,005 por megapixel. O piso usado aqui é US$ 0,01.
- Flux na fal fica entre US$ 0,012 e US$ 0,048 por imagem. Um prompt SD no Midjourney sai perto de US$ 0,03 no plano.
- Leonardo cobra cerca de US$ 0,0010 a US$ 0,0014 por token no plano mensal. Alchemy e o Ideogram ficam em US$ 0,02 a US$ 0,04 por imagem. Esse é o referencial do Qwen.
- MiniMax H3 na fal sai a cerca de US$ 0,03 a US$ 0,05 por segundo. Um clipe de cerca de 5 s fica em US$ 0,20.
- Motion control curto, na faixa Magnific/Kling, fica em US$ 0,10 a US$ 0,30. O Wan usa US$ 0,25.

A conta de cada modelo é `max(segundos / 3600 × POD_USD_PER_HOUR × TOKEN_MARGIN, preço de mercado) / TOKEN_USD`, arredondada.

| Modelo | Segundos | GPU | Mercado | Tokens | USD |
| --- | --- | --- | --- | --- | --- |
| Z-Image | 24 | US$ 0,0047 | US$ 0,010 | 10 | 0,010 |
| Flux 2 | 242 | US$ 0,047 | US$ 0,030 | 71 | 0,071 |
| Qwen Image 2.1 | 756 | US$ 0,147 | US$ 0,040 | 220 | 0,220 |
| Auto imagem | média | — | média | média, roda o Flux 2 | — |
| MiniMax | 486 | US$ 0,095 | US$ 0,200 | 200 | 0,200 |
| Wan Animate | 282 | US$ 0,055 | US$ 0,250 | 250 | 0,250 |
| Auto vídeo | média | — | média | média, roda o MiniMax | — |

O Z-Image e os dois vídeos encostam no preço de mercado, porque a GPU com margem fica abaixo dele. Flux e Qwen encostam no custo com margem: vender pelo mercado daria prejuízo neste pod. O Qwen só tem uma amostra longa. Uma segunda corrida quente deve baixar `AVERAGE_SECONDS` em `src/pricing.ts`.

O auto de imagem cobra 100 tokens, a média dos três, e executa o Flux 2, o do meio no tempo. O auto de vídeo cobra 225 tokens e executa o MiniMax, porque o Wan não gera só com texto.

Pacotes de referência, ainda sem efeito no saldo: 1.000 tokens por US$ 1, 10.000 por US$ 9 (10% abaixo da lista) e 30.000 por US$ 24 (20% abaixo). O consumo usa sempre o preço de lista. Não há cartão nem webhook. O saldo é `users.token_balance`, e cada movimento vai para `token_ledger`.

`GET /v1/workflows` devolve `token_usd`, `pod_usd_per_hour`, `margin`, `packs` e, em cada modelo, `tokens`, `usd`, `gpu_usd`, `market_usd` e `average_seconds`. O front não inventa esses números.

## Galeria e e-mail

`GET /v1/gallery` lista os assets da conta. A URL assinada dura 15 minutos. `DELETE /v1/gallery/{id}` apaga o documento e o objeto debaixo de `invente.ai/`.

Os e-mails (confirmar conta, redefinir senha, geração pronta, geração falhou) estão em `src/email/templates.ts` e saem pelo Resend. O domínio `invente.ai` precisa estar verificado lá.

## Pod

A ficha é `pods/a6000-sp-1`: `base_url` `https://yx0pr60l7cmv48-8188.proxy.runpod.net`, `token_secret` `inventa-pod-a6000-sp-1-token`, `max_concurrent` 1, timeouts 480 s e 900 s. O token não entra em variável de ambiente nem no git. Os grafos em formato de API estão em `workflows/`.

Sem a ficha, ou sem o segredo, o job termina em `pod_not_configured` e o débito volta.

## O que ainda não existe

Pagamento, DNS de `api.invente.ai` na Cloudflare, sorteio no modo auto e uma segunda amostra de tempo do Qwen quente.
