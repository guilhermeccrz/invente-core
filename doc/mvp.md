# MVP: geração, tokens, galeria e e-mail

Este texto registra o que o serviço `invente-core` faz agora, por que cada escolha foi essa, e o que fica para o passo seguinte. Não há pagamento. O saldo entra no Firestore quando a gente credita a conta.

## O que entrou

- O worker fala com o ComfyUI do pod `a6000-sp-1` (`https://yx0pr60l7cmv48-8188.proxy.runpod.net`), com os cinco fluxos exportados em `workflows/`.
- `POST /v1/generate` devolve o job na hora. O cliente consulta `GET /v1/jobs/{id}` a cada 4 segundos (`poll_after_ms`). Enquanto o estágio é `generating`, o percentual sobe com o tempo até 90 e só vai a 100 quando o arquivo existe. Não há websocket: cada consulta é uma leitura, e o worker não grava o Firestore a cada segundo.
- O saldo é `users.token_balance`. Cada geração debita na entrada da fila. Se a tentativa termina em erro, o valor volta. O extrato fica em `token_ledger`.
- A galeria é `GET /v1/gallery` e `DELETE /v1/gallery/{id}`. O delete apaga o documento e o objeto debaixo de `invente.ai/`. A URL assinada dura 15 minutos.
- Os e-mails transacionais (confirmação, senha, geração pronta, geração falhou) têm texto e HTML em `src/email/templates.ts`. O envio continua sendo o Resend, fora do GCP.
- O modo `image_auto` e o modo `video_auto` cobram a média da tabela e executam o modelo do meio.

## Por que o token custa isso

Não existia uma tabela antes. O número segue o tempo de GPU já medido neste pod, não um preço de mercado.

| Pedido | Roda | Tokens | Base |
| --- | --- | --- | --- |
| `zimage_t2i` | Z-Image | 10 | cerca de 24 s com o modelo quente |
| `qwen_image_2_1_t2i` | Qwen Image 2.1 | 20 | modelo do meio, entre o rascunho e o Flux |
| `flux2_t2i` | Flux 2 | 40 | cerca de 111 s quente e 371 s frio |
| `image_auto` | Qwen Image 2.1 | 23 | média de 10, 20 e 40, arredondada |
| `minimax_i2v` | MiniMax | 80 | vídeo de cerca de 5 s |
| `wan_animate` | Wan Animate | 120 | foto e vídeo de entrada |
| `video_auto` | MiniMax | 100 | média de 80 e 120 |

O modo auto cobra a média para o preço não mudar conforme o modelo da vez. Ele executa o modelo do meio (Qwen na imagem, MiniMax no vídeo) porque é o que cabe nessa média sem puxar o Flux frio nem o Wan. A diferença de 3 tokens entre os 23 do auto de imagem e os 20 do Qwen manual é de propósito: o auto é um preço fechado, um pouco acima do modelo que ele usa hoje.

Dez mil tokens na conta inicial dão cerca de 434 imagens no auto, ou 100 vídeos no auto, se nada falhar. Falha devolve o valor.

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
- O modo auto não sorteia o modelo. Ele sempre usa o do meio e cobra a média.
- Uma geração real no pod, com o arquivo novo em `/workspace/ComfyUI/output`, ainda precisa de uma rodada com o token do pod publicado no Secret Manager. Os fluxos já estão no repositório no formato da API.

## Próximos passos

1. Verificar `support@invente.ai` no Resend, se ainda não estiver.
2. Publicar o segredo `inventa-pod-a6000-sp-1-token` e a ficha `pods/a6000-sp-1` se a geração ao vivo ainda responder `pod_not_configured`.
3. Quando for a hora do pagamento, trocar o crédito manual por um webhook que grave `credito_manual` com a referência da compra. A tabela de tokens pode continuar a mesma.
4. Se o auto passar a sortear o modelo, o preço 23 e o preço 100 viram o custo esperado, e o extrato passa a guardar qual modelo saiu.
5. Apontar `api.invente.ai` para o Cloud Run quando o domínio for ligado.
