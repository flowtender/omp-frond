import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { getSetting, setSetting } from "./omp-settings.ts";
import { buildSessionContext } from "./session-reader.ts";
import { readRestoredComposer } from "./session-composer.ts";
import { persistExplicitStartupPreferences } from "./startup-preferences.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function thinkingEntry(id, parentId, thinkingLevel, configured) {
  return { type: "thinking_level_change", id, parentId, timestamp, thinkingLevel, configured };
}

test("restoring a branch retains Auto separately from its resolved effort", () => {
  const entries = [
    thinkingEntry("auto", null, "high", "auto"),
    thinkingEntry("resolved", "auto", "low", "auto"),
    thinkingEntry("manual", "auto", "medium", "medium"),
  ];
  const automatic = buildSessionContext(entries, "resolved");
  assert.equal(automatic.configuredThinkingLevel, "auto");
  assert.equal(automatic.thinkingLevel, "low");
  const manual = buildSessionContext(entries, "manual");
  assert.equal(manual.configuredThinkingLevel, "medium");
  assert.equal(manual.thinkingLevel, "medium");
});

test("explicit Auto persists as Auto rather than the first resolved effort", async () => {
  const settings = await Settings.loadIsolated({ inMemory: true });
  await persistExplicitStartupPreferences(
    settings,
    { thinkingLevel: "auto" },
    { thinkingLevel: "high", supportsThinking: true },
  );
  assert.equal(getSetting(settings, "defaultThinkingLevel"), "auto");
});

test("restored composer uses omp's effective shimmer preference", async () => {
  const settings = await Settings.loadIsolated({ inMemory: true });
  const context = buildSessionContext([], null);
  const registry = { getAvailable: () => [] };
  setSetting(settings, "display.shimmer", "kitt");
  setSetting(settings, "tui.motion", "full");
  assert.equal((await readRestoredComposer(context, [], settings, registry)).shimmer, "kitt");
  setSetting(settings, "tui.motion", "reduced");
  assert.equal((await readRestoredComposer(context, [], settings, registry)).shimmer, "disabled");
});

test("a conversation without receipts previews the SDK default role and reasoning", async () => {
  const settings = await Settings.loadIsolated({ inMemory: true });
  const model = { provider: "custom", id: "current", name: "Current", reasoning: true, thinking: { efforts: ["low", "medium", "high"] } };
  settings.setModelRole("default", "custom/current:medium");
  const entries = [{
    type: "message", id: "last", parentId: null, timestamp,
    message: { role: "assistant", provider: "custom", model: "previous", content: [] },
  }];
  const registry = { getAvailable: () => [model] };
  const restored = await readRestoredComposer(buildSessionContext(entries, "last"), entries, settings, registry);
  assert.deepEqual(restored.model, { provider: "custom", modelId: "current" });
  assert.equal(restored.modelRole, "default");
  assert.equal(restored.configuredThinkingLevel, "medium");
});
