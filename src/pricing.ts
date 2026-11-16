import type { CatalogItem, MediaKind } from "./catalog.js";
import { findWorkflow } from "./catalog.js";

export const MANUAL_PRICE = {
  zimage_t2i: 10,
  qwen_image_2_1_t2i: 20,
  flux2_t2i: 40,
  minimax_i2v: 80,
  wan_animate: 120,
} as const;

export const IMAGE_AUTO_TOKENS = 23;
export const VIDEO_AUTO_TOKENS = 100;

const AUTO = {
  image_auto: { runs: "qwen_image_2_1_t2i", tokens: IMAGE_AUTO_TOKENS, kind: "image" as const },
  video_auto: { runs: "minimax_i2v", tokens: VIDEO_AUTO_TOKENS, kind: "video" as const },
};

export type GenerationMode = "auto" | "manual";

export type ResolvedChoice = {
  requested: string;
  workflow: string;
  mode: GenerationMode;
  kind: MediaKind;
  tokens: number;
  spec: CatalogItem;
};

export function resolveChoice(id: string): ResolvedChoice | null {
  const auto = AUTO[id as keyof typeof AUTO];
  if (auto) {
    const spec = findWorkflow(auto.runs);
    if (!spec) return null;
    return { requested: id, workflow: auto.runs, mode: "auto", kind: auto.kind, tokens: auto.tokens, spec };
  }
  const spec = findWorkflow(id);
  if (!spec) return null;
  const tokens = MANUAL_PRICE[id as keyof typeof MANUAL_PRICE];
  if (!tokens) return null;
  return { requested: id, workflow: id, mode: "manual", kind: spec.kind, tokens, spec };
}

export function offersForPods(pods: { enabled: boolean; workflows: string[] }[]) {
  const enabled = new Set(pods.filter((pod) => pod.enabled).flatMap((pod) => pod.workflows));
  const manual = Object.entries(MANUAL_PRICE)
    .filter(([id]) => enabled.has(id))
    .map(([id, tokens]) => {
      const spec = findWorkflow(id);
      return { id, kind: spec?.kind || "image", mode: "manual" as const, tokens, runs: id };
    });
  const auto = Object.entries(AUTO)
    .filter(([, item]) => enabled.has(item.runs))
    .map(([id, item]) => ({ id, kind: item.kind, mode: "auto" as const, tokens: item.tokens, runs: item.runs }));
  return [...manual, ...auto];
}
