import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession, Settings } from "@oh-my-pi/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, handler = async () => {}) {
  let ui;
  const errors = [];
  const inner = {
    sessionId: "extension-ui-test",
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    sessionManager: { getCwd: () => "/tmp" },
    settings: Settings.isolated(),
    agent: { state: {}, abort() {} },
    abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, dispose() {},
    // Use the SDK's actual command dispatch and idle-agent abort paths.
    prompt: AgentSession.prototype.prompt,
    _tryExecuteExtensionCommand: AgentSession.prototype._tryExecuteExtensionCommand,
    abort: AgentSession.prototype.abort,
    waitForIdle: AgentSession.prototype.waitForIdle,
    _extensionRunner: {
      getCommand: () => ({ handler: () => handler(ui) }),
      createCommandContext: () => ({}),
      emitError: (error) => errors.push(error),
    },
    extensionRunner: {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  ui = wrapper.createExtensionUiContext();
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, ui, events, errors };
}

for (const method of ["select", "confirm", "input", "editor", "custom"]) {
  test(`Stop unwinds a command waiting on ${method} and closes its UI`, async (t) => {
    let continued = false;
    let disposed = 0;
    const { wrapper, events, errors } = setup(t, async (ui) => {
      if (method === "custom") {
        await ui.custom(() => ({ render: () => ["Choose"], dispose: () => { disposed += 1; } }));
      } else {
        await ui[method]("Choose", method === "select" ? ["A", "B"] : "Details");
      }
      continued = true;
    });
    const sending = wrapper.send({ type: "prompt", message: "/choose" });
    await nextTurn();
    const request = events.find((event) => event.method === method);
    assert.ok(request);
    assert.equal(wrapper.isRunning(), true);

    await wrapper.send({ type: "abort" });
    await sending;
    await nextTurn();
    assert.equal(continued, false);
    assert.equal(wrapper.isRunning(), false);
    assert.equal(wrapper.pendingUiRequests.size, 0);
    assert.equal(wrapper.pendingUiResponses.size, 0);
    assert.equal(wrapper.activeCustomUis.size, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /cancelled by Stop/);
    assert.ok(events.some((event) => event.id === request.id && (event.type === "extension_ui_closed" || event.closed)));
    assert.ok(events.some((event) => event.type === "prompt_done"));
    assert.equal(disposed, method === "custom" ? 1 : 0);
    const replay = [];
    wrapper.onEvent((event) => replay.push(event))();
    assert.equal(replay.some((event) => event.id === request.id), false);

    // A later explicit command can ask again; answering still resumes it.
    const nextSending = wrapper.send({ type: "prompt", message: "/choose" });
    await nextTurn();
    const nextRequest = events.findLast((event) => event.method === method && !event.closed);
    assert.notEqual(nextRequest.id, request.id);
    if (method === "custom") wrapper.closeCustomUi(nextRequest.id, "A");
    else await wrapper.send({ type: "extension_ui_response", id: nextRequest.id, value: "A", confirmed: true });
    await nextSending;
    assert.equal(continued, true);
  });
}

test("normal cancel and caller abort keep UI defaults and notify all subscribers", async (t) => {
  const { wrapper, ui, events } = setup(t);
  const pending = ui.select("Choose", ["A"]);
  const request = events.at(-1);
  await wrapper.send({ type: "extension_ui_response", id: request.id, cancelled: true });
  assert.equal(await pending, undefined);
  assert.deepEqual(events.at(-1), { type: "extension_ui_closed", id: request.id });

  const controller = new AbortController();
  const confirm = ui.confirm("Confirm", "Continue?", { signal: controller.signal });
  controller.abort();
  assert.equal(await confirm, false);
  assert.equal(wrapper.pendingUiRequests.size, 0);
});

test("select sends option labels as strings and descriptions positionally", async (t) => {
  const { wrapper, ui, events } = setup(t);
  const pending = ui.select("Spend a saved reset?", [
    { label: "Yes", description: "Redeem now" },
    "Maybe",
    { label: "No" },
  ]);
  const request = events.at(-1);
  assert.deepEqual(request.options, ["Yes", "Maybe", "No"]);
  assert.deepEqual(request.optionDetails, [{ description: "Redeem now" }, {}, {}]);
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: "Yes" });
  assert.equal(await pending, "Yes");
});

test("select without descriptions omits optionDetails", async (t) => {
  const { ui, events } = setup(t);
  void ui.select("Choose", ["A", { label: "B", description: "  " }]);
  const request = events.at(-1);
  assert.deepEqual(request.options, ["A", "B"]);
  assert.equal("optionDetails" in request, false);
});

test("Stop cancels a custom UI factory that has not mounted yet", async (t) => {
  const { wrapper, ui, events } = setup(t);
  let finishFactory;
  let disposed = false;
  const pending = ui.custom(() => new Promise((resolve) => { finishFactory = resolve; }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await nextTurn();
  await wrapper.send({ type: "abort" });
  await rejected;
  finishFactory({ render: () => ["Late panel"], dispose: () => { disposed = true; } });
  await nextTurn();
  assert.equal(disposed, true);
  assert.equal(events.some((event) => event.method === "custom"), false);
  assert.equal(wrapper.activeCustomUis.size, 0);
  await assert.rejects(ui.select("Reopen after Stop", ["A"]), { name: "AbortError" });
});

test("Stop before custom UI initialization does not invoke the factory", async (t) => {
  const { wrapper, ui } = setup(t);
  let invoked = false;
  const pending = ui.custom(() => { invoked = true; return { render: () => [] }; });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await wrapper.send({ type: "abort" });
  await rejected;
  assert.equal(invoked, false);
});

test("pendingExtensionUiIds lists the requests a joining client must reconcile, and drops answered ones", async (t) => {
  const { wrapper, ui, events } = setup(t);
  assert.deepEqual(wrapper.pendingExtensionUiIds(), []);
  const pending = ui.select("Choose", ["A"]);
  const request = events.at(-1);
  assert.deepEqual(wrapper.pendingExtensionUiIds(), [request.id]);
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: "A" });
  assert.equal(await pending, "A");
  assert.deepEqual(wrapper.pendingExtensionUiIds(), []);
});

test("onEvent replays the assistant reply in progress until its message or run ends", (t) => {
  const { wrapper } = setup(t);
  const update = { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } };
  wrapper.trackStreamingMessageEvent(update);
  const joined = [];
  wrapper.onEvent((event) => joined.push(event));
  assert.deepEqual(joined.filter((event) => event.type === "message_update"), [update]);
  wrapper.trackStreamingMessageEvent({ type: "message_end", message: update.message });
  const afterEnd = [];
  wrapper.onEvent((event) => afterEnd.push(event));
  assert.deepEqual(afterEnd.filter((event) => event.type === "message_update"), []);
  wrapper.trackStreamingMessageEvent(update);
  wrapper.trackStreamingMessageEvent({ type: "agent_end", messages: [] });
  const afterRun = [];
  wrapper.onEvent((event) => afterRun.push(event));
  assert.deepEqual(afterRun.filter((event) => event.type === "message_update"), []);
});
