import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Run the route with isolated session and timer dependencies, without starting an SDK runtime.
const source = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
const body = ast.statements.filter((node) => !ts.isImportDeclaration(node))
  .map((node) => node.getText(ast).replace(/^export /, "")).join("\n");
const { outputText } = ts.transpileModule(body, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
});

function harness({ cold = false } = {}) {
  const timers = new Map();
  const state = { subscriptions: 0, unsubscriptions: 0, listener: null };
  const session = {
    sessionId: "session-a",
    runtimeId: "runtime:a",
    isAlive: () => true,
    onEvent(listener) {
      state.subscriptions += 1;
      state.listener = listener;
      return () => { state.unsubscriptions += 1; };
    },
  };
  let finishStartup;
  const startup = new Promise((resolve) => { finishStartup = () => resolve({ session }); });
  const dependencies = {
    getRpcSession: () => cold ? undefined : session,
    resolveSessionPath: async () => "session.jsonl",
    startRpcSession: () => startup,
    isApiRequestAllowed: () => true,
    setInterval: (callback) => { const id = Symbol(); timers.set(id, callback); return id; },
    clearInterval: (id) => timers.delete(id),
  };
  const GET = new Function(...Object.keys(dependencies), `${outputText}\nreturn GET;`)(...Object.values(dependencies));
  const controller = new AbortController();
  const response = GET(new Request("http://localhost/api/agent/session-a/events", {
    signal: controller.signal,
  }), { params: Promise.resolve({ id: "session-a" }) });
  return { state, timers, controller, response, finishStartup };
}

test("a client disconnecting during session startup never acquires a subscription or heartbeat", async () => {
  const h = harness({ cold: true });
  // Let the handler reach the shared startup promise before disconnecting.
  await new Promise((resolve) => setImmediate(resolve));
  h.controller.abort();
  h.finishStartup();
  const response = await h.response;
  assert.equal(await response.text(), "");
  assert.equal(h.state.subscriptions, 0);
  assert.equal(h.timers.size, 0);
});

for (const disconnect of ["abort", "cancel"]) {
  test(`${disconnect} releases a live stream exactly once and ignores queued events`, async () => {
    const h = harness();
    const response = await h.response;
    const reader = response.body.getReader();
    const connected = new TextDecoder().decode((await reader.read()).value);
    assert.match(connected, /"type":"connected"/);
    assert.match(connected, /"runtimeId":"runtime:a"/);
    assert.equal(h.timers.size, 1);
    if (disconnect === "abort") h.controller.abort();
    else await reader.cancel();
    assert.equal(h.state.unsubscriptions, 1);
    assert.equal(h.timers.size, 0);
    h.controller.abort();
    await reader.cancel();
    h.state.listener({ type: "message_update", message: { content: "late" } });
    assert.equal(h.state.unsubscriptions, 1);
    assert.deepEqual(await reader.read(), { value: undefined, done: true });
  });
}
