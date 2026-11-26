import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Runs the hook's own model-switch and composer callbacks, removing only the
// TypeScript syntax, against recorded React state.
const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
const callbacks = new Map();
(function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(ast) === "useCallback") {
    callbacks.set(node.name.text, node.initializer.arguments[0].getText(ast));
  }
  ts.forEachChild(node, collect);
})(ast);

function callback(name, bindings) {
  assert.ok(callbacks.has(name), `Missing callback: ${name}`);
  const { outputText } = ts.transpileModule(`const callback = ${callbacks.get(name)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn callback;`)(...Object.values(bindings));
}

const saved = { provider: "acme", modelId: "saved" };
const snapshot = (model) => ({
  source: "live", shimmer: "classic", modelRole: "default", model,
  thinkingLevel: "off", configuredThinkingLevel: "off",
});

function harness({ override = null } = {}) {
  const state = { override, switching: false, notices: [] };
  const commands = [];
  const reloads = [];
  const setCurrentModelOverride = (value) => {
    state.override = typeof value === "function" ? value(state.override) : value;
  };
  const modelSwitchPendingRef = { current: false };
  const applyComposer = callback("applyComposer", {
    modelSwitchPendingRef,
    setCurrentModelOverride,
    setComposerStatus() {},
    setThinkingLevel() {},
    setEffectiveThinkingLevel() {},
    asConcreteThinkingLevel: (level) => level,
  });
  // A history reload hands the composer the saved session's snapshot.
  const loadSession = async (sid) => {
    reloads.push(sid);
    applyComposer(snapshot(saved));
  };
  const handleModelChange = callback("handleModelChange", {
    isNew: false,
    sessionIdRef: { current: "s" },
    modelSwitchPendingRef,
    currentModelOverride: override,
    setCurrentModelOverride,
    setModelSwitching: (value) => { state.switching = value; },
    sendAskingCacheLoss: (sid, command) => {
      const reply = Promise.withResolvers();
      commands.push({ sid, command, ...reply });
      return reply.promise;
    },
    loadSession,
    addNotice: (notice) => state.notices.push(notice),
    console: { error() {} },
  });
  return { state, commands, reloads, applyComposer, handleModelChange };
}

test("a picked model shows at once, and a second pick waits for the first switch", async () => {
  const { state, commands, reloads, handleModelChange } = harness();
  const first = handleModelChange("acme", "fast");
  assert.deepEqual(state.override, { provider: "acme", modelId: "fast" });
  assert.equal(state.switching, true);

  await handleModelChange("acme", "slow");
  assert.equal(commands.length, 1, "the second pick sends nothing while the first is in flight");
  assert.deepEqual(commands[0].command, { type: "set_model", provider: "acme", modelId: "fast" });

  commands[0].resolve(true);
  await first;
  assert.equal(state.switching, false);
  assert.deepEqual(reloads, ["s"], "the session reloads its canonical state once the switch lands");
});

test("a session reload cannot clear the model of an in-flight switch", async () => {
  const { state, commands, applyComposer, handleModelChange } = harness();
  const switching = handleModelChange("acme", "fast");
  applyComposer(snapshot(saved), true);
  applyComposer(snapshot(saved));
  assert.deepEqual(state.override, { provider: "acme", modelId: "fast" });

  commands[0].resolve(true);
  await switching;
  // Once it lands, reloads own the composer again: an idle saved session shows its own model.
  assert.equal(state.override, null);
  applyComposer(snapshot(saved), true);
  assert.deepEqual(state.override, saved);
});

test("keeping the warm cache leaves the previous model in place", async () => {
  const previous = { provider: "acme", modelId: "before" };
  const { state, commands, reloads, handleModelChange } = harness({ override: previous });
  const switching = handleModelChange("acme", "fast");
  commands[0].resolve(false);
  await switching;
  assert.deepEqual(state.override, previous);
  assert.equal(state.switching, false);
  assert.deepEqual(reloads, []);
});

test("a failed switch restores the previous model, reports it and rereads the session", async () => {
  const previous = { provider: "acme", modelId: "before" };
  const { state, commands, reloads, handleModelChange } = harness({ override: previous });
  const switching = handleModelChange("acme", "fast");
  commands[0].reject(new Error("HTTP 500"));
  await switching;
  assert.deepEqual(state.notices, [{ type: "error", message: "Failed to switch model: HTTP 500" }]);
  assert.deepEqual(reloads, ["s"]);
  assert.equal(state.switching, false);
  // The reread settled the composer on what the session file says.
  assert.equal(state.override, null);
});
