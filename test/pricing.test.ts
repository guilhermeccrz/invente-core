import assert from "node:assert/strict";
import test from "node:test";
import { gpuUsd, quoteAuto, quoteModel, resolveChoice, tokensFor, type Rates } from "../src/pricing.js";

const rates: Rates = { podUsdPerHour: 0.7, tokenUsd: 0.001, margin: 1.5 };

test("token cobre o maior entre custo com margem e preco de mercado", () => {
  const cheap = quoteModel("zimage_t2i", rates);
  assert.equal(cheap.tokens, tokensFor(cheap.gpu_usd, cheap.market_usd, rates));
  assert.equal(cheap.tokens, 10);
  assert.ok(cheap.gpu_usd * rates.margin < cheap.market_usd);

  const heavy = quoteModel("qwen_image_2_1_t2i", rates);
  assert.ok(heavy.gpu_usd * rates.margin > heavy.market_usd);
  assert.equal(heavy.tokens, Math.round((heavy.gpu_usd * rates.margin) / rates.tokenUsd));
  assert.equal(heavy.usd, heavy.tokens * rates.tokenUsd);
});

test("subir o custo do pod aumenta o modelo limitado pela GPU e nao o limitado pelo mercado", () => {
  const dear: Rates = { ...rates, podUsdPerHour: 0.9 };
  assert.ok(quoteModel("flux2_t2i", dear).tokens > quoteModel("flux2_t2i", rates).tokens);
  assert.equal(quoteModel("zimage_t2i", dear).tokens, quoteModel("zimage_t2i", rates).tokens);
});

test("auto de imagem cobra a media e roda o modelo do meio", () => {
  const auto = quoteAuto("image", rates);
  const manual = [quoteModel("zimage_t2i", rates), quoteModel("flux2_t2i", rates), quoteModel("qwen_image_2_1_t2i", rates)];
  const mean = Math.round(manual.reduce((sum, item) => sum + item.tokens, 0) / manual.length);
  assert.equal(auto.tokens, mean);
  assert.equal(auto.runs, "flux2_t2i");
  assert.equal(resolveChoice("image_auto", rates)?.tokens, auto.tokens);
  assert.ok(auto.tokens > quoteModel("flux2_t2i", rates).tokens);
});

test("custo de GPU e segundos vezes a hora do pod", () => {
  assert.equal(gpuUsd(3600, rates), 0.7);
  assert.equal(gpuUsd(24, rates), Math.round((24 / 3600) * 0.7 * 1_000_000) / 1_000_000);
});
