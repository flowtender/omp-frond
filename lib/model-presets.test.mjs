import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import "@oh-my-pi/pi-coding-agent/config/all-settings";
import { createJiti } from "jiti";

const {
  activateModelPreset,
  createModelPreset,
  findPresetShadows,
  listModelPresets,
  parseModelPresetInput,
  readActivatablePreset,
  removeModelPreset,
  updateModelPreset,
} = await createJiti(import.meta.url).import("./model-presets.ts");

const MODELS = [
  { provider: "anthropic", id: "claude-opus", name: "Claude Opus", api: "anthropic-messages", reasoning: true },
  { provider: "anthropic", id: "claude-haiku", name: "Claude Haiku", api: "anthropic-messages", reasoning: true },
];

/** `projectConfig` is the project's `.omp/config.yml`, written before the settings load. */
async function withSettings(run, projectConfig) {
  const root = await mkdtemp(join(tmpdir(), "omp-frond-model-presets-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".omp"), { recursive: true });
  await mkdir(agentDir);
  if (projectConfig) await writeFile(join(cwd, ".omp", "config.yml"), projectConfig);
  try {
    await run({ settings: await Settings.loadIsolated({ cwd, agentDir, inMemory: true }), cwd });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("saves the current roles and thinking level as a new preset, and refuses a taken or invalid name", async () => {
  await withSettings(async ({ settings }) => {
    settings.setModelRole("default", "anthropic/claude-opus:high");
    settings.setModelRole("smol", "anthropic/claude-haiku");
    lookup("defaultThinkingLevel").set(settings, "medium");

    createModelPreset(settings, settings, "work");

    const [preset] = listModelPresets(settings, MODELS);
    assert.deepEqual(preset, {
      name: "work",
      source: "global",
      active: true,
      modelRoles: { default: "anthropic/claude-opus:high", smol: "anthropic/claude-haiku" },
      resolved: { default: "anthropic/claude-opus", smol: "anthropic/claude-haiku" },
      defaultThinkingLevel: "medium",
    });
    assert.throws(() => createModelPreset(settings, settings, "work"), { status: 409 });
    assert.throws(() => createModelPreset(settings, settings, "2fast"), { status: 400 });
  });
});

test("a preset edited past the current roles is no longer active, and can be removed", async () => {
  await withSettings(async ({ settings }) => {
    settings.setModelRole("default", "anthropic/claude-opus");
    createModelPreset(settings, settings, "work");

    updateModelPreset(settings, settings, "work", parseModelPresetInput({ default: "anthropic/claude-haiku" }, "low"));
    const [preset] = listModelPresets(settings, MODELS);
    assert.equal(preset.active, false);
    assert.deepEqual(preset.modelRoles, { default: "anthropic/claude-haiku" });
    assert.equal(preset.defaultThinkingLevel, "low");

    removeModelPreset(settings, settings, "work");
    assert.deepEqual(listModelPresets(settings, MODELS), []);
  });
});

test("refuses preset input omp could not read back", () => {
  assert.throws(() => parseModelPresetInput({ default: "" }, undefined), { status: 400 });
  assert.throws(() => parseModelPresetInput({ default: "anthropic/claude-opus" }, "off"), { status: 400 });
  assert.deepEqual(parseModelPresetInput({ default: " anthropic/claude-opus " }, "auto"), {
    modelRoles: { default: "anthropic/claude-opus" },
    defaultThinkingLevel: "auto",
  });
});

test("a project's preset is listed and activatable but cannot be edited or removed here", async () => {
  await withSettings(async ({ settings }) => {
    const [preset] = listModelPresets(settings, MODELS);
    assert.equal(preset.source, "project");
    assert.throws(() => updateModelPreset(settings, settings, "repo", parseModelPresetInput({}, undefined)), { status: 409 });
    assert.throws(() => removeModelPreset(settings, settings, "repo"), { status: 409 });
    assert.deepEqual(readActivatablePreset(settings, "repo").modelRoles, { default: "anthropic/claude-haiku" });
  }, "modelPresets:\n  repo:\n    modelRoles:\n      default: anthropic/claude-haiku\n");
});

test("activating globally replaces the global roles and thinking level", async () => {
  await withSettings(async ({ settings, cwd }) => {
    settings.setModelRole("default", "anthropic/claude-opus");
    settings.setModelRole("smol", "anthropic/claude-haiku");
    const preset = parseModelPresetInput({ default: "anthropic/claude-haiku" }, "high");

    await activateModelPreset({ scoped: settings, global: settings, cwd, preset, scope: "global", candidates: MODELS });

    assert.equal(settings.getModelRole("default"), "anthropic/claude-haiku");
    assert.equal(settings.getModelRole("smol"), undefined);
    assert.equal(lookup("defaultThinkingLevel").get(settings), "high");
    assert.deepEqual(findPresetShadows(settings, preset), { shadowed: [] });
  });
});

test("activation writes nothing when the preset's default model is not available", async () => {
  await withSettings(async ({ settings, cwd }) => {
    settings.setModelRole("default", "anthropic/claude-opus");
    const preset = parseModelPresetInput({ default: "anthropic/claude-haiku" }, undefined);

    await assert.rejects(
      activateModelPreset({ scoped: settings, global: settings, cwd, preset, scope: "global", candidates: [MODELS[0]] }),
      { status: 409 },
    );
    assert.equal(settings.getModelRole("default"), "anthropic/claude-opus");
  });
});

test("reports a role a project config still decides after a global activation", async () => {
  await withSettings(async ({ settings, cwd }) => {
    const preset = parseModelPresetInput({ default: "anthropic/claude-haiku" }, undefined);
    await activateModelPreset({ scoped: settings, global: settings, cwd, preset, scope: "global", candidates: MODELS });

    assert.deepEqual(findPresetShadows(settings, preset).shadowed, [
      { role: "default", expected: "anthropic/claude-haiku", actual: "anthropic/claude-opus", source: "project" },
    ]);
  }, "modelRoles:\n  default: anthropic/claude-opus\n");
});

test("activating into a project needs one, and a global activation does not", async () => {
  await withSettings(async ({ settings }) => {
    const preset = parseModelPresetInput({ default: "anthropic/claude-haiku" }, undefined);

    await assert.rejects(
      activateModelPreset({ scoped: settings, global: settings, cwd: undefined, preset, scope: "project", candidates: MODELS }),
      { status: 400 },
    );
    await activateModelPreset({ scoped: settings, global: settings, cwd: undefined, preset, scope: "global", candidates: MODELS });
    assert.equal(settings.getModelRole("default"), "anthropic/claude-haiku");
  });
});
