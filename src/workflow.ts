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
