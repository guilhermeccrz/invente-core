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
