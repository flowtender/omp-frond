import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";

// startRpcSession() builds real SDK sessions; keep them out of the developer's
// agent dir. The omp runtime is a process-wide singleton, so the whole file
// shares one agent dir (same convention as rpc-manager-lifecycle.test.mjs).
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-model-config-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getRpcSession, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { GET: readSession } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { POST: sendCommand } = await jiti.import("../app/api/agent/[id]/route.ts");
const { GET: openEvents } = await jiti.import("../app/api/agent/[id]/events/route.ts");
const { writeModelsConfig } = await jiti.import("./models-config-store.ts");
refreshDirsFromEnv();

// omp migrates settings.json to config.yml (archiving the JSON verbatim as
// *.bak) and models.json to models.yml on the first session load. The fork's
// store still writes the JSON paths, so seed those and let the migration run;
// after it the SDK reads only the YAML, so saved edits must target models.yml
// (JSON text is valid YAML).
const settingsPath = join(agentDir, "settings.json");
const settingsBefore = JSON.stringify({ defaultThinkingLevel: "low", retry: { enabled: false }, compaction: { enabled: false } });
await writeFile(settingsPath, settingsBefore);
const config = { providers: { acme: {
  baseUrl: "https://acme.invalid", api: "anthropic-messages", apiKey: "acme-not-a-key",
  models: [{ id: "primary", reasoning: true, contextWindow: 32000, maxTokens: 1024 }],
} } };
writeModelsConfig(config, join(agentDir, "models.json"));
const configPath = join(agentDir, "config.yml");
const save = () => writeFile(join(agentDir, "models.yml"), JSON.stringify(config));

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  refreshDirsFromEnv();
  // Session startup can ensureDir the per-cwd store directory against the
  // pre-refresh (real) store root; sweep this file's temp projects so no
  // run leaves empty rows in the developer's session store.
  const sessionsRoot = getSessionsDir();
  for (const name of await readdir(sessionsRoot).catch(() => [])) {
    if (name.startsWith("-tmp-pi-web-model-reselect-")) {
      await rm(join(sessionsRoot, name), { recursive: true, force: true });
    }
  }
  await rm(agentDir, { recursive: true, force: true });
});

async function fixture(t, thinkingLevel = "high") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-model-reselect-"));
  // No real credentials, extensions, catalog fetches or model requests.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const { session: wrapper } = await startRpcSession(`__new__${cwd}`, "", cwd, {
    toolNames: [], initialModel: { provider: "acme", modelId: "primary" }, thinkingLevel,
  });
  // The SDK's debounced settings writer must settle before the temp dir goes.
  t.after(async () => {
    await wrapper.shutdown();
    await rm(cwd, { recursive: true, force: true });
  });
  // First-load migration facts; stable across tests once the runtime exists.
  assert.equal(await access(settingsPath).then(() => true, () => false), false, "settings.json must migrate away");
  assert.equal(await readFile(`${settingsPath}.bak`, "utf8"), settingsBefore);
  assert.equal(await access(join(agentDir, "models.yml")).then(() => true, () => false), true, "models.json must migrate to models.yml");
  const configAfterStart = await readFile(configPath, "utf8");
  return { wrapper, config, save, settingsPath, configPath, configAfterStart };
}

const modelEntries = (inner) => inner.sessionManager.getEntries().filter((entry) =>
  entry.type === "model_change" || entry.type === "thinking_level_change");

test("refreshing an active session keeps Auto before the first thinking receipt", async (t) => {
  const { wrapper } = await fixture(t, "auto");
  const { sessionId } = wrapper;
  const request = new Request(`http://localhost/api/sessions/${sessionId}`, {
    headers: { host: "localhost" },
  });
  const params = Promise.resolve({ id: sessionId });
  const refresh = async () => {
    const response = await readSession(request, { params });
    assert.equal(response.status, 200);
    return (await response.json()).context;
  };

  assert.equal(modelEntries(wrapper.inner).some((entry) => entry.type === "thinking_level_change"), false);
  const live = await wrapper.send({ type: "get_state" });
  const automatic = await refresh();
  assert.equal(automatic.configuredThinkingLevel, "auto");
  assert.equal(automatic.thinkingLevel, live.thinkingLevel);

  await wrapper.send({ type: "set_thinking_level", level: "off" });
  const disabled = await refresh();
  assert.equal(disabled.configuredThinkingLevel, "off");
  assert.equal(disabled.thinkingLevel, "off");
});

test("a reopened chat restores its composer before switching to live readings", async (t) => {
  const { wrapper } = await fixture(t);
  const { sessionId, inner } = wrapper;
  const manager = inner.sessionManager;
  const timestamp = Date.now();
  manager.appendModelChange("acme/primary", "slow");
  await wrapper.send({ type: "set_thinking_level", level: "medium" });
  manager.appendMessage({ role: "user", content: "hello", timestamp });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "hi" }],
    api: "anthropic-messages", provider: "acme", model: "primary",
    usage: { input: 0, output: 0 }, stopReason: "stop", timestamp,
  });
  await manager.flush();
  t.after(async () => { await getRpcSession(sessionId)?.shutdown(); });

  const params = Promise.resolve({ id: sessionId });
  const headers = { host: "localhost", "content-type": "application/json" };
  const changeTools = await sendCommand(new Request(`http://localhost/api/agent/${sessionId}`, {
    method: "POST", headers, body: JSON.stringify({ type: "set_tools", toolNames: ["read", "grep", "glob"] }),
  }), { params });
  assert.equal(changeTools.status, 200, await changeTools.text());
  await getRpcSession(sessionId)?.shutdown();

  const result = await readSession(new Request(`http://localhost/api/sessions/${sessionId}`, { headers }), { params });
  assert.equal(result.status, 200);
  const { context } = await result.json();
  const model = { provider: "acme", modelId: "primary" };
  assert.equal(context.source, "restored");
  assert.deepEqual(context.model, model);
  assert.equal(context.modelRole, "slow");
  assert.equal(context.configuredThinkingLevel, "medium");
  assert.equal(context.toolPreset, "read-only");
  assert.equal(getRpcSession(sessionId), undefined);

  const stream = await openEvents(new Request(`http://localhost/api/agent/${sessionId}/events`, { headers }), { params });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  try {
    const { value } = await reader.read();
    const { composer } = JSON.parse(new TextDecoder().decode(value).slice("data: ".length));
    assert.equal(composer.source, "live");
    assert.deepEqual(composer.model, model);
    assert.equal(composer.modelRole, "slow");
    assert.equal(composer.configuredThinkingLevel, "medium");
    assert.equal(composer.toolPreset, "read-only");
  } finally {
    await reader.cancel();
  }
});

test("reselecting a model applies a saved same-id edit and keeps the thinking level", async (t) => {
  const f = await fixture(t);
  const { inner } = f.wrapper;
  Object.assign(f.config.providers.acme.models[0], {
    api: "openai-responses", baseUrl: "https://acme.invalid/v1", contextWindow: 64000,
  });
  await f.save();
  assert.equal(inner.model.api, "anthropic-messages", "Saving must not touch a live session");
  await f.wrapper.send({ type: "set_model", provider: "acme", modelId: "primary" });
  assert.equal(inner.model.api, "openai-responses");
  assert.equal(inner.model.baseUrl, "https://acme.invalid/v1");
  assert.equal(inner.model.contextWindow, 64000);
  assert.equal(inner.thinkingLevel, "high", "defaultThinkingLevel=low must not replace the session's level");
  assert.equal(await readFile(f.configPath, "utf8"), f.configAfterStart, "reselecting must not rewrite the migrated config");

  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(`${url.hostname}${url.pathname}`);
    return new Response(JSON.stringify({ error: { message: "Offline interception", type: "fixture" } }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  });
  await inner.prompt("Synthetic request, intercepted locally.");
  assert.deepEqual(requests, ["acme.invalid/v1/responses"], "The SDK request uses the new route");

  // A model that no longer reasons clamps the kept level, as any model switch does.
  f.config.providers.acme.models[0].reasoning = false;
  await f.save();
  await f.wrapper.send({ type: "set_model", provider: "acme", modelId: "primary" });
  assert.equal(inner.thinkingLevel, "off");
});

test("reselecting an unchanged model writes no model or thinking entries", async (t) => {
  const { wrapper } = await fixture(t);
  const selected = wrapper.inner.model;
  const setModel = t.mock.method(wrapper.inner, "setModel");
  const before = modelEntries(wrapper.inner);
  await wrapper.send({ type: "set_model", provider: "acme", modelId: "primary" });
  assert.equal(setModel.mock.callCount(), 0);
  assert.deepEqual(modelEntries(wrapper.inner), before);
  assert.deepEqual(wrapper.inner.model, selected);
});
