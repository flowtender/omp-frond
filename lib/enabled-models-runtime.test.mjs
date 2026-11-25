import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { groupEnabledModelRows } from "./enabled-models-presentation.ts";

const {
  buildEnabledModelsView,
  readEnabledModelsSettings,
  resolvePatternMatches,
  resolveProviderGlobs,
  writeEnabledModels,
} = await import("./enabled-models-runtime.ts");

const tempDirs = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const model = (provider, id, name = id) => ({
  provider,
  id,
  name,
  api: "anthropic-messages",
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
  input: ["text"],
});

const MODELS = [
  model("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6"),
  model("anthropic", "claude-opus-4-1", "Claude Opus 4.1"),
  model("openai", "gpt-5.5", "GPT-5.5"),
  model("commandcode", "sakana/fugu-ultra", "Fugu Ultra"),
  model("commandcode", "gpt-5.5", "GPT-5.5 (Command Code)"),
];

/** Settings backed by real files, like the shared runtime's. */
async function settingsWith({ global, project } = {}) {
  const agentDir = await tempDir("omp-web-enabled-agent-");
  const cwd = await tempDir("omp-web-enabled-project-");
  if (global !== undefined) await writeFile(join(agentDir, "config.yml"), global);
  if (project !== undefined) {
    await mkdir(join(cwd, ".omp"), { recursive: true });
    await writeFile(join(cwd, ".omp", "config.yml"), project);
  }
  return { agentDir, settings: await Settings.loadIsolated({ agentDir, cwd }) };
}

test("provider rows promote an assigned model without changing the enabled scope", async () => {
  const { settings } = await settingsWith({
    global: "modelRoles:\n  default: anthropic/claude-sonnet-4-6\n",
  });
  const models = MODELS.filter((entry) => entry.provider === "anthropic");
  const [sonnet, opus] = models;
  const view = buildEnabledModelsView({
    input: {
      availableRefs: models.map((entry) => `${entry.provider}/${entry.id}`),
      patterns: [`${opus.provider}/${opus.id}`],
      resolutions: [{ pattern: `${opus.provider}/${opus.id}`, matched: [`${opus.provider}/${opus.id}`] }],
    },
    models,
    providerNames: new Map(),
    newRefs: new Set(),
    settingsPath: "config.yml",
  });
  groupEnabledModelRows(view, settings, { getAll: () => MODELS, getAvailable: () => [] }, models);
  const rows = view.providers[0].models;
  assert.deepEqual(rows.map(({ id, enabled }) => [id, enabled]), [[sonnet.id, false], [opus.id, true]]);
  assert.deepEqual(rows[0].roles, [{ role: "default", label: "default" }]);
  assert.equal(rows[0].recent, true);
  assert.equal(rows[1].recent, undefined);
});

test("each pattern is resolved on its own through omp's resolver, with its thinking pin", async () => {
  const resolutions = await resolvePatternMatches(["anthropic/*:high", "openai/gpt-5.5", "gone/*"], MODELS);
  assert.deepEqual(resolutions, [
    {
      pattern: "anthropic/*:high",
      matched: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-1"],
      pin: "high",
    },
    { pattern: "openai/gpt-5.5", matched: ["openai/gpt-5.5"] },
    { pattern: "gone/*", matched: [] },
  ]);
});

test("a provider glob is only offered when it matches exactly that provider", async () => {
  // `commandcode/*` misses the nested id; `anthropic/*` covers its provider.
  assert.deepEqual(await resolveProviderGlobs(MODELS), {
    anthropic: "anthropic/*",
    openai: "openai/*",
    commandcode: "commandcode/**",
  });
});

test("the global value is editable and names config.yml", async () => {
  const { settings } = await settingsWith({ global: "enabledModels:\n  - anthropic/*\n" });
  const read = readEnabledModelsSettings(settings);
  assert.deepEqual(read.patterns, ["anthropic/*"]);
  assert.equal(read.readOnlyReason, undefined);
  assert.match(read.path, /config\.yml$/);
});

test("a project value shadows the global one and makes the switches read-only", async () => {
  const { settings } = await settingsWith({
    global: "enabledModels:\n  - anthropic/*\n",
    project: "enabledModels:\n  - openai/*\n",
  });
  const read = readEnabledModelsSettings(settings);
  assert.deepEqual(read.patterns, ["openai/*"]);
  assert.equal(read.readOnlyReason, "project-scope");
});

test("path-scoped global entries make the switches read-only", async () => {
  const { settings } = await settingsWith({
    global: "enabledModels:\n  - anthropic/*\n  - path: /nowhere\n    models: [openai/*]\n",
  });
  assert.equal(readEnabledModelsSettings(settings).readOnlyReason, "path-scoped");
});

test("writes land in config.yml, and clearing removes the key", async () => {
  const { agentDir, settings } = await settingsWith({ global: "modelRoles:\n  smol: openai/gpt-5.5\n" });
  await writeEnabledModels(settings, ["anthropic/claude-opus-4-1", "openai/*"]);
  const written = await readFile(join(agentDir, "config.yml"), "utf8");
  assert.match(written, /enabledModels:/);
  assert.match(written, /anthropic\/claude-opus-4-1/);
  assert.match(written, /smol: openai\/gpt-5\.5/);
  assert.deepEqual(readEnabledModelsSettings(settings).patterns, ["anthropic/claude-opus-4-1", "openai/*"]);

  await writeEnabledModels(settings, undefined);
  assert.doesNotMatch(await readFile(join(agentDir, "config.yml"), "utf8"), /enabledModels/);
  assert.equal(readEnabledModelsSettings(settings).patterns, undefined);
});
