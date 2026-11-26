import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { userMessageKey } from "../lib/prompt-recovery.ts";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "sendStreamingPrompt") {
    callback = node.initializer.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const code = ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

for (const behavior of ["steer", "followUp"]) {
  for (const delivered of [false, true]) {
    test(`${behavior}: lost response ${delivered ? "found in queue" : "restores without resend"}`, async () => {
      const effects = [];
      const queue = { steering: [], followUp: [] };
      const bindings = {
        sessionIdRef: { current: "session" }, runtimeIdRef: { current: null }, composerDraftKey: "session",
        entryIdsRef: { current: [] },
        queuedMessages: queue, messagesRef: { current: [] }, sessionHookMountedRef: { current: true },
        userMessageKey, isPromptRejectedError: () => false,
        normalizeQueuedMessages: (q) => q ?? { steering: [], followUp: [] },
        agentStatusUrl: (id) => `/agent/${id}`,
        sendAgentCommand: async (_sid, command) => { effects.push(["send", command]); throw new Error("connection lost"); },
        fetch: async (url) => ({ ok: true, json: async () => url.startsWith("/agent/")
          ? { state: { queuedMessages: { steering: delivered && behavior === "steer" ? ["text"] : [], followUp: delivered && behavior === "followUp" ? ["text"] : [] } } }
          : { context: { messages: [] } } }),
        restoreSubmission: (...args) => effects.push(["restore", ...args]),
        addNotice: (notice) => effects.push(["notice", notice]),
      };
      const send = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
      await send("text", behavior);
      assert.equal(effects.filter(([kind]) => kind === "send").length, 1);
      assert.equal(effects.filter(([kind]) => kind === "restore").length, delivered ? 0 : 1);
      if (!delivered) assert.ok(effects.some(([kind, notice]) => kind === "notice" && notice.type === "warning"));
    });
  }
}

test("older matching history cannot confirm a queued submission", async () => {
  const effects = [];
  const bindings = {
    sessionIdRef: { current: "session" }, runtimeIdRef: { current: null }, composerDraftKey: "session",
    entryIdsRef: { current: ["anchor"] },
    queuedMessages: { steering: [], followUp: [] }, messagesRef: { current: [] },
    sessionHookMountedRef: { current: true }, userMessageKey, isPromptRejectedError: () => false,
    normalizeQueuedMessages: (q) => q ?? { steering: [], followUp: [] },
    agentStatusUrl: (id) => `/agent/${id}`,
    sendAgentCommand: async () => { throw new Error("connection lost"); },
    fetch: async (url) => ({ ok: true, json: async () => url.startsWith("/agent/")
      ? { state: { queuedMessages: { steering: [], followUp: [] } } }
      : { context: { entryIds: ["old", "anchor"], messages: [{ role: "user", content: "text" }, { role: "assistant", content: [] }] } } }),
    restoreSubmission: (...args) => effects.push(["restore", ...args]),
    addNotice: (notice) => effects.push(["notice", notice]),
  };
  const send = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  await send("text", "steer");
  assert.equal(effects.filter(([kind]) => kind === "restore").length, 1);
});

test("recovery after switching sessions returns text to the sending session", async () => {
  const effects = [];
  const sessionIdRef = { current: "first" };
  const bindings = {
    sessionIdRef, runtimeIdRef: { current: null }, composerDraftKey: "first",
    entryIdsRef: { current: [] }, queuedMessages: { steering: [], followUp: [] },
    messagesRef: { current: [] }, sessionHookMountedRef: { current: true },
    userMessageKey, isPromptRejectedError: () => false,
    normalizeQueuedMessages: (q) => q ?? { steering: [], followUp: [] },
    agentStatusUrl: (id) => `/agent/${id}`,
    sendAgentCommand: async () => { sessionIdRef.current = "second"; throw new Error("connection lost"); },
    fetch: async (url) => ({ ok: true, json: async () => url.startsWith("/agent/")
      ? { state: { queuedMessages: { steering: [], followUp: [] } } }
      : { context: { messages: [] } } }),
    restoreSubmission: (...args) => effects.push(["restore", ...args]),
    addNotice: (notice) => effects.push(["notice", notice]),
  };
  const send = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  await send("text", "steer");
  assert.deepEqual(effects, [["restore", "text", undefined, "first"]]);
});
