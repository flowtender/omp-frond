/**
 * The vendor whose model this is, read off the model id, as the provider id
 * whose icon stands for that vendor. Resellers and gateways (OpenRouter,
 * Copilot, Bedrock, a local Strata server, ...) serve other vendors' models, so
 * the provider alone does not say whose model answers.
 *
 * Ids arrive bare (`claude-opus-5-5`), path-prefixed (`anthropic/claude-opus-5-5`)
 * or dot-prefixed (`us.anthropic.claude-opus-5-5`); a family name counts only at
 * the start of one of those segments.
 */
const MODEL_FAMILY_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ["claude", "anthropic"],
  ["(?:gpt|chatgpt|codex|o\\d(?:-|$))", "openai"],
  ["(?:gemini|gemma)", "google"],
  ["grok", "xai"],
  ["deepseek", "deepseek"],
  ["(?:qwen|qwq)", "qwen"],
  ["kimi", "kimi-coding"],
  ["glm", "zai"],
  ["(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)", "mistral"],
  ["minimax", "minimax"],
  ["mimo", "xiaomi"],
  ["command-", "cohere"],
  ["nemotron", "nvidia"],
  ["sonar", "perplexity"],
  ["(?:llama|meta-llama|muse-spark|muse-wonder|muse-ember)", "meta"],
];

const FAMILY_MATCHERS = MODEL_FAMILY_PROVIDERS.map(
  ([family, provider]) => [new RegExp(`(?:^|[/.:])${family}`), provider] as const,
);

export function modelFamilyProvider(modelId: string): string | undefined {
  const id = modelId.toLowerCase();
  return FAMILY_MATCHERS.find(([matcher]) => matcher.test(id))?.[1];
}
