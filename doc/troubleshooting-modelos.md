# Antes de culpar o modelo novo

Isto é o que apareceu ao fazer Z-Image, Qwen, Flux 2, MiniMax e Wan Animate gerarem de verdade no pod `a6000-sp-1`. Serve para o próximo modelo, quando o job ficar em 0% ou a fila não andar.

O browser não fala com o Comfy. A API grava o job, o Cloud Tasks chama o worker, o worker manda `POST /prompt` e fica em `GET /history/{prompt_id}`. O arquivo sai de `/workspace/ComfyUI/output/...` para `invente.ai/users/{userId}/images|videos/{assetId}.ext`.

Há um slot só. `max_concurrent` é 1. O próximo modelo espera o anterior terminar.

## Trinta segundos de leitura

No pod, por SSH (`RunPod-MVP`):

```
nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader
tail -c 400 /var/log/supervisor/comfyui.log
```

Repita a memória uns 8 segundos depois. O log também está em `/workspace/ComfyUI/user/comfyui_18188.log`. O processo escuta em `18188`. O proxy que a UI e o worker usam é o `8188`.

| O que se vê | O que é |
| --- | --- |
| Memória da GPU subindo, mesmo com utilização 0% | Cópia dos pesos. Esperar. |
| Utilização alta, log em `0/N Model Initializing` | Amostragem ou compilação. Esperar. O Wan fez isso a 93% e 46 GB e terminou 6 passos. |
| Memória parada, CPU do processo parado, a mesma linha do log por minutos | Travado. Não é carregamento lento. |
| `got prompt` e em seguida `Required input is missing` ou `prompt_outputs_failed_validation` | O grafo foi recusado. O nome do nó no log é o que está errado. |
| `Prompt executed in ...` | Esse prompt acabou no Comfy. O worker ainda precisa baixar o arquivo e gravar o bucket. |

Utilização 0% sozinha não diz nada. Na carga dos pesos o CUDA não roda: o trabalho é disco e CPU. A barra do tqdm usa `\r` e muitas vezes não grava linha nova, então um log quieto com memória subindo ainda é carga.

Para o CPU, em dois instantes, some `utime` e `stime` de `/proc/{pid}/stat` do `python main.py --port 18188`. Delta perto de zero, com a memória da GPU parada, é processo dormindo. Delta alto, ou `VmRSS` crescendo, é carga. O encoder de texto do Flux fica `current: cpu` no log: a memória da GPU pode demorar a subir enquanto a RAM do processo sobe.

## O que já quebrou, e o conserto

### Grafo recusado

O arquivo em `/workspace/ComfyUI/user/default/workflows/` é o formato do editor (versão 0.4, com `definitions.subgraphs`). Não é o corpo de `POST /prompt`. A UI expande o subgraph e manda o formato de API. O serviço guarda esse formato expandido em `workflows/*.json`.

Os widgets do editor não caem no mesmo campo da API. Quando a exportação desloca um valor, o Comfy recusa antes de carregar modelo:

- Flux, nó de escala: `megapixels` recebeu a string `lanczos`.
- Flux e MiniMax: `KSamplerSelect` sem `sampler_name`.
- MiniMax: `denoise` 4.0, acima de 1.
- Wan: o unet e a lora trocados, e chaves de combo dinâmico (`format`, `codec`) faltando.

O conserto é copiar os `inputs` de um prompt que já gerou no histórico do Comfy, e trocar `:` por `_` nos ids (`68:6` vira `68_6`) dos dois lados do link. Conferir no fim: `sampler_name`, nome do `.safetensors`, e o campo de texto que o manifest aponta.

`POST /prompt` só exige `prompt`. `extra_data`, `extra_pnginfo`, `client_id` e `partial_execution_targets` são opcionais. O `extra_pnginfo` guarda o grafo do editor dentro do PNG. Não faz o modelo rodar. A documentação atual do Comfy descreve isso como metadado.

Arquivos do editor neste pod:

- `image_z_image_turbo.json`
- `image_flux2.json` — subgraph "Image Edit (FLUX.2 Dev)". Turbo desligado, 20 passos, não 8. A imagem de exemplo `image_flux2_input_image.png` continua ligada, porque no catálogo a imagem do Flux é `no`: o serviço não troca e não desconecta.
- `image_qwen_image_2_1_t2i.json`
- `video_minimax_h3_i2v.json` — subgraph "Image to Video (MiniMax H3)".
- `video_wan_animate2.json` — pede imagem e vídeo.

### Imagem de exemplo indo sem querer

Se o catálogo diz `optional` e o pedido não manda `image_asset_id`, o worker desconecta o `LoadImage` e apaga o nó. A foto de exemplo do template não entra. O MiniMax que gerou foi só texto; `image_asset_id` ficou nulo. A amostra `transparent_rgb_gaming_mouse.png` não foi usada.

Wan é `required` nos dois. Sem imagem e sem vídeo o pedido nem entra na fila. O que gerou usou a imagem do Z-Image e o mp4 do MiniMax.

### Fila empilhada

Sintoma no `GET /queue` do `18188`: `running 1` e `pending 2`, com a mesma contagem de nós. No log, vários `got prompt` enquanto o primeiro ainda carrega modelo.

Duas causas, as duas já vistas:

1. O prazo de despacho do Cloud Tasks é 600 s se a tarefa não disser outro. Um job de 20 minutos recebe outra tentativa com a primeira ainda aberta. O worker agora cria a tarefa com `dispatchDeadline` de 1800 s.
2. Um `GET /history` que estoura 30 s no meio da carga fazia o worker desistir e o retry mandava outro prompt. Timeout ou abort nessa consulta agora só continua o poll. O prazo geral do job é que encerra.

Se o pod está ocupado, o worker não responde 503. Reagenda o mesmo job para daqui a 30 s e responde 200. O 503 queimava as 3 tentativas e deixava o job `queued` com tokens `held` e a fila do Cloud Tasks vazia.

`comfy_timeout` é terminal: não empilha outro prompt em cima de uma carga que talvez ainda esteja viva. Na desistência, o interrupt leva `{prompt_id}`. Sem esse campo o Comfy faz "Global interrupt" e mata qualquer coisa que esteja na placa, inclusive uma carga boa.

Para tirar só o que está pendente, sem matar o que roda: `POST /queue` com `{"delete": ["id-pendente"]}`. Não usar `{"clear": true}` nem interrupt global enquanto a memória ou o log ainda andam.

### Prazo curto demais

Carga fria do Flux 2: encoder Mistral de cerca de 33 GB mais o unet de cerca de 33 GB. Uma corrida fria saudável no histórico levou por volta de 6 minutos. Uma corrida interrompida no meio do `Model Initializing` ficou 20 minutos em 0% e não chegou a amostrar.

Hoje a ficha do pod está com `image_timeout_seconds` 1700 e `video_timeout_seconds` 1200. O Cloud Run do worker está em 1800 s, acima do poll. MiniMax terminou em 842 s. Wan terminou em 434 s. Os dois cabem em 1200 s.

Se a memória não se mexe, aumentar o prazo não salva. Só adia o estorno.

### Comfy "waiting for service" depois do restart

`supervisorctl restart all` sobe o AI-Dock na hora. A UI fica em "waiting for service to respond" enquanto o `python main.py --port 18188` importa custom nodes. O ComfyUI-Manager sozinho levou 83 s. O log então diz `Starting server` e `To see the GUI go to: http://127.0.0.1:18188`. `curl` em `/system_stats` nessa porta responde 200 quando está pronto.

Processo em estado `D`, com tempo de CPU `00:00:00` e o log sem mudar de mtime, não está importando. Está em sono que não aceita interrupt, em geral disco ou driver. Reiniciar o processo de novo, no mesmo volume travado, repete o sintoma. Esperar o `Starting server` antes de enfileirar outro job. Mandar prompt contra o proxy enquanto o 18188 ainda sobe devolve `pod_indisponivel` e pode gastar as tentativas da tarefa.

Não interromper uma carga em que a memória ainda sobe. O interrupt global no meio do `Model Initializing` deixou o carregador do Flux preso: a tentativa seguinte ficou em `Requested to load Flux2TEModel_` com CPU e disco parados.

## Checklist de um modelo novo

1. Rodar uma vez na UI do pod, até sair arquivo em `/workspace/ComfyUI/output`.
2. Pegar esse prompt no histórico, não o JSON do menu File → Save.
3. Gravar em `workflows/{id}.json` com os ids `:` virados em `_`, links inclusive.
4. Preencher `workflows/manifest.json`: campo do texto, campo do seed, `load_image`, `load_video`, nó de saída.
5. No catálogo, marcar imagem e vídeo como `required`, `optional` ou `no`. `optional` sem asset desconecta a mídia de exemplo.
6. Conferir no JSON final o `sampler_name`, o nome do checkpoint e o texto que o manifest escreve.
7. Subir um job só. Olhar memória e CPU, não só o percentual da GPU.
8. Se o log nomear um nó, corrigir o input desse nó a partir do histórico. Não reinventar a ordem dos widgets.
9. Anotar os segundos reais e revisar `AVERAGE_SECONDS` em `src/pricing.ts`. Uma amostra fria deixa o preço alto.

O token do pod fica no segredo `inventa-pod-a6000-sp-1-token`. Não entra no git, no log nem num script commitado. O header é `Authorization: Bearer`.

## O que já saiu do outro lado

| Modelo | Pod | Bucket |
| --- | --- | --- |
| Z-Image | `/workspace/ComfyUI/output/z-image-turbo_00002_.png` | `.../images/36572483f4362ea74b275dffb460920f.png` |
| Qwen | `/workspace/ComfyUI/output/Qwen_image_2.1_00002.png` | `.../images/51f6466b79956ebb4c0b78e8ccaf0c24.png` |
| MiniMax, só texto | `/workspace/ComfyUI/output/video/MiniMax_H3_00002_.mp4` | `.../videos/8b24e15b94aa7b31e56f143e7f1a2d3e.mp4` |
| Wan Animate | `/workspace/ComfyUI/output/video/ComfyUI_00003_.mp4` | `.../videos/b76f00a1706e4e8e4a13b4eeebbda099.mp4` |
| Flux 2 | `/workspace/ComfyUI/output/Flux2_00003_.png` | `.../images/745fd16d30f907f9f33fd7a83ee05233.png` |

O prefixo do bucket é `invente.ai/users/25401d1539b28658f2c9d228180006d6/`. O Flux aceitou o grafo nas tentativas anteriores e morreu no prazo, ou porque o Comfy foi reiniciado no meio da carga. Com o processo no ar, a mesma fila terminou em 380 s. Não tratar aquele timeout como grafo inválido.
