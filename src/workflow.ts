import type { ComfyPrompt } from "./comfy.js";

export type WorkflowTarget = { node: string; input: string };

export type WorkflowManifest = {
  kind: "image" | "video";
  prompt: WorkflowTarget[];
  seeds: WorkflowTarget[];
  load_image: WorkflowTarget | null;
  load_video: WorkflowTarget | null;
  output_node: string | null;
};

export function patchWorkflow(
  source: ComfyPrompt,
  manifest: WorkflowManifest,
  input: { prompt?: string; seed: number; imageName?: string | null; videoName?: string | null; disconnectImage?: boolean },
): ComfyPrompt {
  const prompt = structuredClone(source);
  if (input.prompt) {
    for (const target of manifest.prompt) writeInput(prompt, target, input.prompt);
  }
  for (const target of manifest.seeds) writeInput(prompt, target, input.seed);
  if (input.imageName && manifest.load_image) writeInput(prompt, manifest.load_image, input.imageName);
  else if (input.disconnectImage && manifest.load_image) disconnect(prompt, manifest.load_image.node);
  if (input.videoName && manifest.load_video) writeInput(prompt, manifest.load_video, input.videoName);
  return prompt;
}

const FRAME_NODES: Record<string, { node: string; width: string; height: string }[]> = {
  zimage_t2i: [{ node: "57_13", width: "width", height: "height" }],
  qwen_image_2_1_t2i: [{ node: "459_456", width: "width", height: "height" }],
  flux2_t2i: [
    { node: "68_47", width: "width", height: "height" },
    { node: "68_48", width: "width", height: "height" },
  ],
  flux2_text_t2i: [
    { node: "98_47", width: "width", height: "height" },
    { node: "98_48", width: "width", height: "height" },
  ],
};

export const IMAGE_FRAMES = [
  { label: "1:1 · 1024×1024", width: 1024, height: 1024 },
  { label: "3:2 · 1216×832", width: 1216, height: 832 },
  { label: "2:3 · 832×1216", width: 832, height: 1216 },
  { label: "16:9 · 1344×768", width: 1344, height: 768 },
  { label: "9:16 · 768×1344", width: 768, height: 1344 },
] as const;

export function allowedFrame(width: number, height: number): boolean {
  return IMAGE_FRAMES.some((frame) => frame.width === width && frame.height === height);
}

export const MINIMAX_SECONDS = [4, 5, 6, 8, 10] as const;

export const MINIMAX_ASPECTS = [
  { id: "1:1 (Square)", label: "1:1" },
  { id: "16:9 (Widescreen)", label: "16:9" },
  { id: "9:16 (Portrait Widescreen)", label: "9:16" },
  { id: "4:3 (Standard)", label: "4:3" },
  { id: "3:4 (Portrait Standard)", label: "3:4" },
  { id: "3:2 (Photo)", label: "3:2" },
  { id: "2:3 (Portrait Photo)", label: "2:3" },
  { id: "21:9 (Ultrawide)", label: "21:9" },
] as const;

export function minimaxSettings() {
  return {
    seconds: [...MINIMAX_SECONDS],
    default_seconds: 5,
    aspects: MINIMAX_ASPECTS.map((item) => ({ id: item.id, label: item.label })),
    default_aspect: "1:1 (Square)",
  };
}

export function allowedMinimaxSeconds(value: number): boolean {
  return (MINIMAX_SECONDS as readonly number[]).includes(value);
}

export function allowedMinimaxAspect(value: string): boolean {
  return MINIMAX_ASPECTS.some((item) => item.id === value);
}

/** A foto de referência entra no tamanho que o seletor de proporção calculou. Sem isso o MiniMax recusa o primeiro quadro. */
export function applyMinimaxSettings(
  prompt: ComfyPrompt,
  input: { seconds: number; aspect: string; scaleReference: boolean },
): void {
  const duration = prompt["105_111"];
  const resolution = prompt["115"];
  const model = prompt["105_104"];
  if (!duration || !resolution || !model) throw new Error("workflow_invalido");
  duration.inputs.value = input.seconds;
  resolution.inputs.aspect_ratio = input.aspect;
  if (!input.scaleReference) return;
  prompt.ref_scale = {
    class_type: "ImageScale",
    inputs: {
      image: ["114", 0],
      upscale_method: "lanczos",
      width: ["115", 0],
      height: ["115", 1],
      crop: "center",
    },
  };
  model.inputs.first_frame = ["ref_scale", 0];
}

export function applyFrameSize(prompt: ComfyPrompt, workflowId: string, width: number, height: number): void {
  const targets = FRAME_NODES[workflowId];
  if (!targets) return;
  for (const target of targets) {
    const node = prompt[target.node];
    if (!node) throw new Error("workflow_invalido");
    node.inputs[target.width] = width;
    node.inputs[target.height] = height;
  }
  if (workflowId === "qwen_image_2_1_t2i" && prompt["459_452"]) {
    prompt["459_452"].inputs.resolution = Math.max(width, height);
  }
}

function writeInput(prompt: ComfyPrompt, target: WorkflowTarget, value: string | number): void {
  const node = prompt[target.node];
  if (!node) throw new Error("workflow_invalido");
  node.inputs[target.input] = value;
}

function disconnect(prompt: ComfyPrompt, nodeId: string): void {
  for (const [id, node] of Object.entries(prompt)) {
    if (id === nodeId) continue;
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && String(value[0]) === nodeId) delete node.inputs[key];
    }
  }
  delete prompt[nodeId];
}
