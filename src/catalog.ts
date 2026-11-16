import { readFileSync } from "node:fs";
import path from "node:path";
import type { ComfyPrompt } from "./comfy.js";
import type { WorkflowManifest } from "./workflow.js";

export type WorkflowId = "zimage_t2i" | "flux2_t2i" | "flux2_text_t2i" | "qwen_image_2_1_t2i" | "minimax_i2v" | "wan_animate";
export type MediaKind = "image" | "video";

export type CatalogItem = {
  id: WorkflowId;
  kind: MediaKind;
  prompt: "required" | "optional";
  image: "required" | "optional" | "no";
  video: "required" | "no";
  drops_image?: boolean;
};

export const CATALOG: CatalogItem[] = [
  { id: "zimage_t2i", kind: "image", prompt: "required", image: "no", video: "no" },
  { id: "flux2_t2i", kind: "image", prompt: "required", image: "optional", video: "no" },
  { id: "flux2_text_t2i", kind: "image", prompt: "required", image: "no", video: "no" },
  { id: "qwen_image_2_1_t2i", kind: "image", prompt: "required", image: "no", video: "no" },
  { id: "minimax_i2v", kind: "video", prompt: "required", image: "optional", video: "no", drops_image: true },
  { id: "wan_animate", kind: "video", prompt: "optional", image: "required", video: "required" },
];

export function findWorkflow(id: string): CatalogItem | null {
  return CATALOG.find((item) => item.id === id) ?? null;
}

export function executionWorkflow(workflow: string, hasImage: boolean): string {
  if (workflow !== "flux2_t2i" && workflow !== "flux2_text_t2i") return workflow;
  return hasImage ? "flux2_t2i" : "flux2_text_t2i";
}

export function podRuns(podWorkflows: string[], workflow: string): boolean {
  if (podWorkflows.includes(workflow)) return true;
  return workflow === "flux2_text_t2i" && podWorkflows.includes("flux2_t2i");
}

export function loadWorkflow(id: string): { prompt: ComfyPrompt; manifest: WorkflowManifest } {
  if (!findWorkflow(id)) throw new Error("workflow_invalido");
  const dir = path.join(process.cwd(), "workflows");
  const prompt = JSON.parse(readFileSync(path.join(dir, `${id}.json`), "utf8")) as ComfyPrompt;
  const all = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Record<string, WorkflowManifest>;
  const manifest = all[id];
  if (!manifest) throw new Error("workflow_invalido");
  return { prompt, manifest };
}

export function workflowsForPods(pods: { enabled: boolean; workflows: string[] }[]): CatalogItem[] {
  const enabled = new Set(pods.filter((pod) => pod.enabled).flatMap((pod) => pod.workflows));
  return CATALOG.filter((item) => enabled.has(item.id));
}
