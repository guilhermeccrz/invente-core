# MVP: geração, tokens, galeria e e-mail

Este texto registra o que o serviço `invente-core` faz agora, por que cada escolha foi essa, e o que fica para o passo seguinte. Não há pagamento. O saldo entra no Firestore quando a gente credita a conta.

## O que entrou

- O worker fala com o ComfyUI do pod `a6000-sp-1` (`https://yx0pr60l7cmv48-8188.proxy.runpod.net`), com os cinco fluxos exportados em `workflows/`.
- `POST /v1/generate` devolve o job na hora. O cliente consulta `GET /v1/jobs/{id}` a cada 4 segundos (`poll_after_ms`). Enquanto o estágio é `generating`, o percentual sobe com o tempo até 90 e só vai a 100 quando o arquivo existe. Não há websocket: cada consulta é uma leitura, e o worker não grava o Firestore a cada segundo.
- O saldo é `users.token_balance`. Cada geração debita na entrada da fila. Se a tentativa termina em erro, o valor volta. O extrato fica em `token_ledger`.
- A galeria é `GET /v1/gallery` e `DELETE /v1/gallery/{id}`. O delete apaga o documento e o objeto debaixo de `invente.ai/`. A URL assinada dura 15 minutos.
- Os e-mails transacionais (confirmação, senha, geração pronta, geração falhou) têm texto e HTML em `src/email/templates.ts`. O envio continua sendo o Resend, fora do GCP.
- O modo `image_auto` cobra a média dos três modelos de imagem e executa o Flux 2, que é o do meio no tempo. O `video_auto` cobra a média e executa o MiniMax, porque o Wan pede foto e vídeo.

## Por que o token custa isso

Não existia uma tabela antes. O número agora sai de duas contas, e a geração cobra a maior.

O pod custa `POD_USD_PER_HOUR` (hoje US$ 0,70). Cada modelo tem uma média de segundos medida no histórico do Comfy em 16 nov 2026. O custo de GPU é `segundos / 3600 × 0,70`.

O preço de lista é `TOKEN_USD` (hoje US$ 0,001), na faixa do token mensal do Leonardo (cerca de US$ 0,0010 a US$ 0,0014). A margem `TOKEN_MARGIN` (hoje 1,5) impede vender abaixo do custo quando o pod esfria.

`tokens = arredondar(max(custo_gpu × margem, preço_de_mercado) / TOKEN_USD)`.

| Pedido | Média | GPU | Mercado | Tokens | USD |
| --- | --- | --- | --- | --- | --- |
| `zimage_t2i` | 24 s | US$ 0,0047 | US$ 0,01 (fal Z-Image ~US$ 0,005/MP) | 10 | 0,010 |
| `flux2_t2i` | 242 s | US$ 0,047 | US$ 0,03 (Flux na fal e prompt SD no Midjourney) | 71 | 0,071 |
| `qwen_image_2_1_t2i` | 756 s | US$ 0,147 | US$ 0,04 (Alchemy / Ideogram) | 220 | 0,220 |
| `image_auto` | média | — | média dos três | média dos tokens, roda o Flux 2 | — |
| `minimax_i2v` | 486 s | US$ 0,095 | US$ 0,20 (fal MiniMax ~US$ 0,03–0,05/s) | 200 | 0,200 |
| `wan_animate` | 282 s | US$ 0,055 | US$ 0,25 (motion control curto) | 250 | 0,250 |
| `video_auto` | média | — | média dos dois | média dos tokens, roda o MiniMax | — |

O Qwen só tem uma amostra e ela é longa. Enquanto não houver uma segunda corrida quente, o preço fica no custo com margem, acima do mercado. O Flux usa a média da corrida fria e da quente.

Os pacotes de referência, ainda sem checkout: 1.000 tokens por US$ 1, 10.000 por US$ 9 e 30.000 por US$ 24. O consumo usa o preço de lista. O saldo continua manual.

A cota antiga continua: 30 imagens e 5 vídeos por hora, no máximo 3 jobs em fila, no máximo 4 itens por pedido. O saldo não substitui essa trava.

## Conta e crédito manual

Enquanto não houver pagamento, o crédito é um documento no Firestore.

- Saldo: campo `token_balance` em `users/{id}`.
- Extrato: coleção `token_ledger`, com `delta`, `balance_after`, `reason` (`geracao`, `estorno` ou `credito_manual`) e `note`.

A conta `guilherme@wedisclaimer.com.br` foi criada já com o e-mail confirmado e com saldo 10000. A senha não entra neste arquivo. Para somar mais tokens, o ajuste é outro crédito no mesmo campo e uma linha `credito_manual` no extrato. Não há checkout, cartão nem webhook.

`GET /v1/me` devolve o saldo. O login também.

## Galeria

Cada asset guarda `kind` (`image` ou `video`), o workflow que rodou, se foi `auto` ou `manual`, o prompt e o job. `GET /v1/gallery?kind=image` lista só as imagens. O delete é do dono da sessão. O objeto tem de continuar em `invente.ai/users/{id}/images|videos/`. Nada fora desse prefixo é apagado, e os prefixos `1900` e `commcor` continuam recusados.

## E-mail

Quatro modelos, todos em português, com a marca invente.ai:

- confirmar o e-mail
- redefinir a senha
- geração pronta, com link para o resultado
- geração falhou, avisando que os tokens voltam

O remetente é `Invente.AI <support@invente.ai>`. A variável lida pelo serviço é `MAIL_FROM`, e `EMAIL_FROM` continua valendo se `MAIL_FROM` estiver vazio. A chave do Resend fica só no segredo `inventa-resend-api-key`. Ela não está no git.

O domínio `invente.ai` precisa estar verificado no Resend para o `support@invente.ai` sair. Sem isso o Resend recusa o envio e o cadastro não grava o usuário.

## Progresso da geração

O estágio vai de `Na fila` a `Preparando`, `Gerando`, `Salvando` e `Pronto`. O percentual de `Gerando` é calculado na leitura, com o tempo já decorrido e o timeout do job (480 s para imagem, 900 s para vídeo), e para em 90 até o arquivo existir. O browser espera `poll_after_ms` (4000) entre uma consulta e outra.

## O que este passo não fez

- Não há cobrança, plano nem nota fiscal.
- O DNS de `api.invente.ai` na Cloudflare continua para depois.
- O modo auto de imagem não sorteia. Ele sempre usa o Flux 2 e cobra a média. O de vídeo sempre usa o MiniMax.
- Uma geração real no pod, com o arquivo novo em `/workspace/ComfyUI/output`, ainda precisa de uma rodada com o token do pod publicado no Secret Manager. Os fluxos já estão no repositório no formato da API.

## Próximos passos

1. Verificar `support@invente.ai` no Resend, se ainda não estiver.
2. Publicar o segredo `inventa-pod-a6000-sp-1-token` e a ficha `pods/a6000-sp-1` se a geração ao vivo ainda responder `pod_not_configured`.
3. Quando for a hora do pagamento, trocar o crédito manual por um webhook que grave `credito_manual` com a referência da compra. A tabela de tokens pode continuar a mesma.
4. Se o auto passar a sortear o modelo, a média vira o custo esperado e o extrato passa a guardar qual modelo saiu. Uma segunda amostra quente do Qwen deve substituir os 756 s.
5. Apontar `api.invente.ai` para o Cloud Run quando o domínio for ligado.
