import assert from "node:assert/strict";
import test from "node:test";
import { executeComfy } from "../src/comfy.js";
import { generatingProgress } from "../src/progress.js";
import { applyFrameSize, applyMinimaxSettings, patchWorkflow, type WorkflowManifest } from "../src/workflow.js";
import { executionWorkflow, loadWorkflow } from "../src/catalog.js";

test("progresso sobe com o tempo e para em 90", () => {
  const started = Date.parse("2026-11-16T00:00:00.000Z");
  assert.equal(generatingProgress(started, started, 480), 35);
  assert.equal(generatingProgress(started, started + 240_000, 480), 62);
  assert.equal(generatingProgress(started, started + 480_000, 480), 90);
});

test("patch troca prompt e seed e desconecta a imagem de exemplo", () => {
  const manifest: WorkflowManifest = {
    kind: "video",
    prompt: [{ node: "encode", input: "text" }],
    seeds: [{ node: "sample", input: "seed" }],
    load_image: { node: "load", input: "image" },
    load_video: null,
    output_node: "save",
  };
  const patched = patchWorkflow(
    {
      load: { class_type: "LoadImage", inputs: { image: "exemplo.png" } },
      encode: { class_type: "Text", inputs: { text: "antigo", pixels: ["load", 0] } },
      sample: { class_type: "Sampler", inputs: { seed: 1 } },
    },
    manifest,
    { prompt: "um gato", seed: 99, disconnectImage: true },
  );
  assert.equal(patched.encode.inputs.text, "um gato");
  assert.equal(patched.sample.inputs.seed, 99);
  assert.equal(patched.load, undefined);
  assert.equal(patched.encode.inputs.pixels, undefined);
});

test("flux sem imagem usa o grafo de texto e com imagem usa o de referencia", () => {
  assert.equal(executionWorkflow("flux2_t2i", false), "flux2_text_t2i");
  assert.equal(executionWorkflow("flux2_text_t2i", false), "flux2_text_t2i");
  assert.equal(executionWorkflow("flux2_t2i", true), "flux2_t2i");
  assert.equal(executionWorkflow("flux2_text_t2i", true), "flux2_t2i");
  assert.equal(executionWorkflow("zimage_t2i", false), "zimage_t2i");
  const text = loadWorkflow("flux2_text_t2i");
  assert.equal(text.manifest.load_image, null);
  assert.equal(text.prompt["98_12"].inputs.unet_name, "flux2_dev_fp8mixed.safetensors");
  applyFrameSize(text.prompt, "flux2_text_t2i", 1344, 768);
  assert.equal(text.prompt["98_47"].inputs.width, 1344);
  assert.equal(text.prompt["98_48"].inputs.height, 768);
  const edit = loadWorkflow("flux2_t2i");
  assert.equal(edit.prompt["46"].class_type, "LoadImage");
  assert.equal(edit.prompt["98_12"], undefined);
});

test("minimax guarda segundos e proporcao e escala a foto de referencia", () => {
  const loaded = loadWorkflow("minimax_i2v");
  const withImage = patchWorkflow(loaded.prompt, loaded.manifest, {
    prompt: "um barco",
    seed: 7,
    imageName: "foto.png",
  });
  applyMinimaxSettings(withImage, { seconds: 8, aspect: "16:9 (Widescreen)", scaleReference: true });
  assert.equal(withImage["105_111"].inputs.value, 8);
  assert.equal(withImage["115"].inputs.aspect_ratio, "16:9 (Widescreen)");
  assert.equal(withImage["114"].inputs.image, "foto.png");
  assert.deepEqual(withImage["105_104"].inputs.first_frame, ["ref_scale", 0]);
  assert.deepEqual(withImage.ref_scale.inputs.width, ["115", 0]);
  assert.deepEqual(withImage.ref_scale.inputs.height, ["115", 1]);

  const textOnly = patchWorkflow(structuredClone(loaded.prompt), loaded.manifest, {
    prompt: "um barco",
    seed: 7,
    disconnectImage: true,
  });
  applyMinimaxSettings(textOnly, { seconds: 5, aspect: "1:1 (Square)", scaleReference: false });
  assert.equal(textOnly["114"], undefined);
  assert.equal(textOnly["105_104"].inputs.first_frame, undefined);
  assert.equal(textOnly.ref_scale, undefined);
});

test("dimensao escolhida entra no latent do flux e do zimage", () => {
  const flux = loadWorkflow("flux2_t2i");
  applyFrameSize(flux.prompt, "flux2_t2i", 1344, 768);
  assert.equal(flux.prompt["68_47"].inputs.width, 1344);
  assert.equal(flux.prompt["68_47"].inputs.height, 768);
  assert.equal(flux.prompt["68_48"].inputs.width, 1344);
  const zimage = loadWorkflow("zimage_t2i");
  applyFrameSize(zimage.prompt, "zimage_t2i", 832, 1216);
  assert.equal(zimage.prompt["57_13"].inputs.width, 832);
  assert.equal(zimage.prompt["57_13"].inputs.height, 1216);
});

test("cliente espera o history e devolve o caminho no pod", async () => {
  let polls = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    if (href.endsWith("/prompt")) {
      return new Response(JSON.stringify({ prompt_id: "p1" }), { status: 200 });
    }
    if (href.includes("/history/p1")) {
      polls += 1;
      if (polls < 2) return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({
          p1: {
            status: { completed: true, status_str: "success" },
            outputs: { "9": { images: [{ filename: "z-image-turbo_00002_.png", subfolder: "", type: "output" }] } },
          },
        }),
        { status: 200 },
      );
    }
    if (href.includes("/view")) return new Response(Buffer.from("png"), { status: 200, headers: { "content-type": "image/png" } });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const result = await executeComfy({
    baseUrl: "https://pod.example",
    token: "segredo",
    prompt: { "9": { class_type: "SaveImage", inputs: {} } },
    timeoutMs: 20_000,
    outputNode: "9",
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: (() => {
      let clock = 0;
      return () => {
        clock += 1000;
        return clock;
      };
    })(),
  });
  assert.equal(result.podPath, "/workspace/ComfyUI/output/z-image-turbo_00002_.png");
  assert.equal(result.contentType, "image/png");
  assert.deepEqual(sleeps, [4000, 4000]);
});

test("timeout interrompe so o prompt que estourou", async () => {
  let body = "";
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/prompt")) return new Response(JSON.stringify({ prompt_id: "p9" }), { status: 200 });
    if (href.endsWith("/interrupt")) {
      body = String(init?.body || "");
      return new Response("ok", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await assert.rejects(
    () =>
      executeComfy({
        baseUrl: "https://pod.example",
        token: "segredo",
        prompt: { "9": { class_type: "SaveImage", inputs: {} } },
        timeoutMs: 3000,
        fetchImpl,
        sleep: async () => undefined,
        now: (() => {
          let clock = 0;
          return () => (clock += 2000);
        })(),
      }),
    /comfy_timeout/,
  );
  assert.equal(body, JSON.stringify({ prompt_id: "p9" }));
});

test("uma consulta lenta ao history nao cancela o prompt", async () => {
  let polls = 0;
  let interrupts = 0;
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    if (href.endsWith("/prompt")) return new Response(JSON.stringify({ prompt_id: "p2" }), { status: 200 });
    if (href.endsWith("/interrupt")) {
      interrupts += 1;
      return new Response("ok", { status: 200 });
    }
    if (href.includes("/history/p2")) {
      polls += 1;
      if (polls === 1) throw Object.assign(new Error("demorou"), { name: "TimeoutError" });
      return new Response(
        JSON.stringify({
          p2: {
            status: { completed: true, status_str: "success" },
            outputs: { "9": { images: [{ filename: "flux.png", subfolder: "", type: "output" }] } },
          },
        }),
        { status: 200 },
      );
    }
    if (href.includes("/view")) return new Response(Buffer.from("png"), { status: 200, headers: { "content-type": "image/png" } });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const result = await executeComfy({
    baseUrl: "https://pod.example",
    token: "segredo",
    prompt: { "9": { class_type: "SaveImage", inputs: {} } },
    timeoutMs: 20_000,
    outputNode: "9",
    fetchImpl,
    sleep: async () => undefined,
    now: (() => {
      let clock = 0;
      return () => (clock += 1000);
    })(),
  });
  assert.equal(result.podPath, "/workspace/ComfyUI/output/flux.png");
  assert.equal(interrupts, 0);
});
