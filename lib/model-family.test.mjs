import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./model-family.ts");
  } catch {
    return import("./model-family.ts");
  }
}

const { modelFamilyProvider } = await loadSubject();

test("reads the vendor off bare, path-prefixed and dot-prefixed ids", () => {
  assert.equal(modelFamilyProvider("claude-opus-5-5"), "anthropic");
  assert.equal(modelFamilyProvider("anthropic/claude-sonnet-5"), "anthropic");
  assert.equal(modelFamilyProvider("us.anthropic.claude-opus-5-5-v1:0"), "anthropic");
  assert.equal(modelFamilyProvider("Qwen3.8-Flash-Next-IQ3_S"), "qwen");
  assert.equal(modelFamilyProvider("google/gemini-3-pro"), "google");
});

test("knows OpenAI's o-series without catching other ids that start with o", () => {
  assert.equal(modelFamilyProvider("o3"), "openai");
  assert.equal(modelFamilyProvider("openai/o4-mini"), "openai");
  assert.equal(modelFamilyProvider("olmo-3-32b"), undefined);
  assert.equal(modelFamilyProvider("opus-local"), undefined);
});

test("matches a family only at the start of a segment", () => {
  assert.equal(modelFamilyProvider("my-claude-finetune"), undefined);
  assert.equal(modelFamilyProvider("ollama-local"), undefined);
});

test("knows Meta's models by name and by namespace", () => {
  assert.equal(modelFamilyProvider("llama-4-maverick"), "meta");
  assert.equal(modelFamilyProvider("meta-llama/Llama-3.3-70B-Instruct"), "meta");
  assert.equal(modelFamilyProvider("muse-spark"), "meta");
});
