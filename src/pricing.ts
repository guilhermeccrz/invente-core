import type { CatalogItem, MediaKind } from "./catalog.js";
import { findWorkflow } from "./catalog.js";

/** USD por hora do pod. Hoje a A6000 sai a 0,70. Troca com POD_USD_PER_HOUR. */
export const DEFAULT_POD_USD_PER_HOUR = 0.7;

/**
 * Preço de lista de um token, em USD.
 * Leonardo cobra cerca de US$ 0,0010 a US$ 0,0014 no plano mensal.
 * O nosso fica em US$ 0,001 até existir checkout. Troca com TOKEN_USD.
 */
export const DEFAULT_TOKEN_USD = 0.001;

/** O varejo não fica abaixo de custo × margem. Cobre a mistura de pod frio e quente. */
export const DEFAULT_MARGIN = 1.5;

/**
 * Segundos médios de GPU neste pod, lidos do histórico do Comfy em 16 nov 2026.
 * Flux é a média da corrida fria (372 s) e da quente (112 s). Os outros têm uma amostra.
 */
export const AVERAGE_SECONDS = {
  zimage_t2i: 24,
  flux2_t2i: 242,
  qwen_image_2_1_t2i: 756,
  minimax_i2v: 486,
  wan_animate: 282,
} as const;

/**
 * Preço público de uma geração parecida, em USD, não o nosso custo.
 * Z-Image: fal cobra cerca de US$ 0,005 por megapixel; o piso de app fica em US$ 0,01.
 * Flux 2: fal fica entre US$ 0,012 e US$ 0,048; um prompt SD no Midjourney sai perto de US$ 0,03.
 * Qwen: Alchemy no Leonardo e o crédito do Ideogram ficam em US$ 0,02 a US$ 0,04.
 * MiniMax: fal cobra US$ 0,03 a US$ 0,05 por segundo; um clipe de cerca de 5 s fica em US$ 0,20.
 * Wan Animate: motion control curto no Magnific/Kling fica em US$ 0,10 a US$ 0,30.
 */
export const MARKET_USD = {
  zimage_t2i: 0.01,
  flux2_t2i: 0.03,
  qwen_image_2_1_t2i: 0.04,
  minimax_i2v: 0.2,
  wan_animate: 0.25,
} as const;

const LABEL: Record<string, string> = {
  zimage_t2i: "Z-Image",
  flux2_t2i: "Flux 2",
  qwen_image_2_1_t2i: "Qwen Image 2.1",
  minimax_i2v: "MiniMax",
  wan_animate: "Wan Animate",
  image_auto: "Auto",
  video_auto: "Auto",
};

export type GenerationMode = "auto" | "manual";

export type Rates = {
  podUsdPerHour: number;
  tokenUsd: number;
  margin: number;
};

export type Quote = {
  id: string;
  kind: MediaKind;
  mode: GenerationMode;
  label: string;
  runs: string;
  tokens: number;
  usd: number;
  average_seconds: number;
  gpu_usd: number;
  market_usd: number;
  needs: { prompt: CatalogItem["prompt"]; image: CatalogItem["image"]; video: CatalogItem["video"] };
};

export type ResolvedChoice = {
  requested: string;
  workflow: string;
  mode: GenerationMode;
  kind: MediaKind;
  tokens: number;
  spec: CatalogItem;
};

type ModelId = keyof typeof AVERAGE_SECONDS;

const IMAGE_IDS: ModelId[] = ["zimage_t2i", "flux2_t2i", "qwen_image_2_1_t2i"];
const VIDEO_IDS: ModelId[] = ["minimax_i2v", "wan_animate"];

export function defaultRates(env: NodeJS.ProcessEnv = process.env): Rates {
  return {
    podUsdPerHour: positive(env.POD_USD_PER_HOUR, DEFAULT_POD_USD_PER_HOUR),
    tokenUsd: positive(env.TOKEN_USD, DEFAULT_TOKEN_USD),
    margin: positive(env.TOKEN_MARGIN, DEFAULT_MARGIN),
  };
}

export function gpuUsd(seconds: number, rates: Rates = defaultRates()): number {
  return money(seconds / 3600 * rates.podUsdPerHour);
}

export function tokensFor(gpu: number, market: number, rates: Rates = defaultRates()): number {
  const retail = Math.max(gpu * rates.margin, market);
  return Math.max(1, Math.round(retail / rates.tokenUsd));
}

export function quoteModel(id: ModelId, rates: Rates = defaultRates()): Quote {
  const spec = findWorkflow(id);
  if (!spec) throw new Error("workflow_invalido");
  const seconds = AVERAGE_SECONDS[id];
  const gpu = gpuUsd(seconds, rates);
  const market = MARKET_USD[id];
  const tokens = tokensFor(gpu, market, rates);
  return {
    id,
    kind: spec.kind,
    mode: "manual",
    label: LABEL[id],
    runs: id,
    tokens,
    usd: money(tokens * rates.tokenUsd),
    average_seconds: seconds,
    gpu_usd: gpu,
    market_usd: market,
    needs: { prompt: spec.prompt, image: spec.image, video: spec.video },
  };
}

export function quoteAuto(kind: MediaKind, rates: Rates = defaultRates()): Quote {
  const ids = kind === "image" ? IMAGE_IDS : VIDEO_IDS;
  const quotes = ids.map((id) => quoteModel(id, rates));
  const runs = kind === "image" ? medianRun(quotes) : "minimax_i2v";
  const spec = findWorkflow(runs);
  if (!spec) throw new Error("workflow_invalido");
  const tokens = Math.max(1, Math.round(mean(quotes.map((item) => item.tokens))));
  const seconds = Math.round(mean(ids.map((id) => AVERAGE_SECONDS[id])));
  return {
    id: kind === "image" ? "image_auto" : "video_auto",
    kind,
    mode: "auto",
    label: "Auto",
    runs,
    tokens,
    usd: money(tokens * rates.tokenUsd),
    average_seconds: seconds,
    gpu_usd: gpuUsd(seconds, rates),
    market_usd: money(mean(ids.map((id) => MARKET_USD[id]))),
    needs: { prompt: spec.prompt, image: spec.image, video: spec.video },
  };
}

export function resolveChoice(id: string, rates: Rates = defaultRates()): ResolvedChoice | null {
  if (id === "flux2_text_t2i") {
    const base = resolveChoice("flux2_t2i", rates);
    const spec = findWorkflow(id);
    if (!base || !spec) return null;
    return { ...base, requested: id, workflow: id, spec };
  }
  const quote = id === "image_auto" || id === "video_auto"
    ? quoteAuto(id === "image_auto" ? "image" : "video", rates)
    : isModel(id) ? quoteModel(id, rates) : null;
  if (!quote) return null;
  const spec = findWorkflow(quote.runs);
  if (!spec) return null;
  return { requested: id, workflow: quote.runs, mode: quote.mode, kind: quote.kind, tokens: quote.tokens, spec };
}

export function offersForPods(pods: { enabled: boolean; workflows: string[] }[], rates: Rates = defaultRates()): Quote[] {
  const enabled = new Set(pods.filter((pod) => pod.enabled).flatMap((pod) => pod.workflows));
  const manual = (Object.keys(AVERAGE_SECONDS) as ModelId[]).filter((id) => enabled.has(id)).map((id) => quoteModel(id, rates));
  const auto = (["image", "video"] as const)
    .map((kind) => quoteAuto(kind, rates))
    .filter((quote) => enabled.has(quote.runs));
  return [...manual, ...auto];
}

/** Referência de pacote. O consumo ainda usa o preço de lista. Não há checkout. */
export function tokenPacks(rates: Rates = defaultRates()) {
  return [
    { id: "mil", tokens: 1000, usd: money(1000 * rates.tokenUsd), off: 0 },
    { id: "essencial", tokens: 10000, usd: money(10000 * rates.tokenUsd * 0.9), off: 0.1 },
    { id: "estudio", tokens: 30000, usd: money(30000 * rates.tokenUsd * 0.8), off: 0.2 },
  ];
}

export function pricingHeader(rates: Rates = defaultRates()) {
  return {
    pod_usd_per_hour: rates.podUsdPerHour,
    token_usd: rates.tokenUsd,
    margin: rates.margin,
    packs: tokenPacks(rates),
  };
}

function medianRun(quotes: Quote[]): string {
  const ordered = [...quotes].sort((a, b) => a.average_seconds - b.average_seconds);
  return ordered[Math.floor(ordered.length / 2)].runs;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function money(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isModel(id: string): id is ModelId {
  return id in AVERAGE_SECONDS;
}
