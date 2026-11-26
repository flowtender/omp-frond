import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as terminalClient from "../lib/terminal-client.ts";
import { createTerminalReplayGuard, createTerminalWriter, terminalRequest } from "../lib/terminal-client.ts";

test("terminal errors preserve server diagnostics and explain non-JSON responses", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch");
  for (const body of [null, "<html>Server error</html>", "null"]) {
    fetch.mock.mockImplementation(async () => new Response(body, { status: 500 }));
    await assert.rejects(terminalRequest("/api/terminal"), /HTTP 500.*pi-web server log/);
  }
  fetch.mock.mockImplementation(async () => Response.json({ error: "Native module missing; run npm rebuild node-pty" }, { status: 500 }));
  await assert.rejects(terminalRequest("/api/terminal"), /Native module missing; run npm rebuild node-pty/);
});

test("a delayed input request cannot be overtaken by typing or resize", async (t) => {
  const received = [];
  let finishFirst;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body));
    if (received.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("a");
  writer.resize(100, 30);
  writer.write("b\r");
  await setImmediate();
  assert.equal(received.length, 1);
  finishFirst();
  await setImmediate();
  assert.deepEqual(received, [
    { type: "input", data: "a" },
    { type: "resize", cols: 100, rows: 30 },
    { type: "input", data: "b\r" },
  ]);
  await writer.stop();
});

test("large Unicode pastes preserve characters while bounding input requests", async (t) => {
  const chunks = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    chunks.push(JSON.parse(options.body).data);
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  const text = "a".repeat(32767) + "\u{1f600}".repeat(40000);
  writer.write(text);
  await setImmediate();
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 65536 && chunk.isWellFormed()));
  await writer.stop();
});

test("typing during a slow request is batched into the next ordered write", async (t) => {
  const received = [];
  let release;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body).data);
    if (received.length === 1) await new Promise((resolve) => { release = resolve; });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("first");
  await setImmediate();
  for (const character of "a long command\r") writer.write(character);
  assert.deepEqual(received, ["first"]);
  release();
  await setImmediate();
  assert.deepEqual(received, ["first", "a long command\r"]);
  await writer.stop();
});

test("failed or stopped delivery discards queued input without retrying commands", async (t) => {
  const errors = [];
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "gone" }, { status: 404 }));
  const writer = createTerminalWriter("id", (error) => errors.push(error.message));
  writer.write("first");
  writer.write("second");
  await setImmediate();
  assert.deepEqual(errors, ["gone"]);
  assert.equal(fetch.mock.callCount(), 1);
  await writer.stop();
  writer.write("third");
  await setImmediate();
  assert.equal(fetch.mock.callCount(), 1);
});

test("fresh shell startup queries receive replies, including in the initial snapshot", () => {
  const replay = createTerminalReplayGuard();
  const sent = [];
  const write = (_data, done) => {
    if (!replay.suppressingInput()) sent.push("\x1b[>0;276;0c");
    done?.();
  };
  replay.open(false);
  replay.write("\x1b[>c", write);
  replay.write("\x1b[>c", write);
  assert.deepEqual(sent, ["\x1b[>0;276;0c", "\x1b[>0;276;0c"]);
});

test("restored and reconnected snapshots suppress replies until asynchronous rendering completes", () => {
  const replay = createTerminalReplayGuard();
  const sent = [];
  const completions = [];
  const write = (_data, done) => {
    completions.push(() => {
      if (!replay.suppressingInput()) sent.push("reply");
      done?.();
    });
  };
  replay.open(true);
  replay.write("\x1b[>c", write);
  assert.equal(replay.suppressingInput(), true);
  // Another connection can begin before the previous write finishes.
  replay.open(true);
  replay.write("\x1b[6n", write);
  completions[0]();
  assert.equal(replay.suppressingInput(), true);
  completions[1]();
  assert.equal(replay.suppressingInput(), false);
  replay.write("\x1b[>c", write);
  completions[2]();
  assert.deepEqual(sent, ["reply"]);
});

test("an empty reconnect snapshot does not suppress subsequent live output", () => {
  const replay = createTerminalReplayGuard();
  const sent = [];
  replay.open(true);
  replay.write("", () => {});
  replay.write("\x1b[>c", (_data, done) => {
    if (!replay.suppressingInput()) sent.push("reply");
    done?.();
  });
  assert.deepEqual(sent, ["reply"]);
});

test("TerminalPanel forwards fresh startup replies but not restored or reconnected history", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (options.body) requests.push({ url, ...JSON.parse(options.body) });
    return Response.json({ success: true });
  });
  const source = readFileSync(new URL("./TerminalPanel.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  });

  async function mount(restored) {
    const effects = [];
    const streams = [];
    const renders = [];
    const container = { offsetWidth: 100, offsetHeight: 100 };
    let firstRef = true;
    let terminal;
    class FakeTerminal {
      constructor(options) { this.options = options; this.cols = 80; this.rows = 24; terminal = this; }
      loadAddon() {}
      open() {}
      attachCustomKeyEventHandler() {}
      onData(fn) { this.onInput = fn; return { dispose() {} }; }
      onResize() { return { dispose() {} }; }
      focus() {}
      reset() {}
      dispose() {}
      write(data, done) { renders.push(() => { if (data.includes("\x1b[>c")) this.onInput("reply"); done?.(); }); }
    }
    class FakeEventSource {
      static CLOSED = 2;
      constructor() { streams.push(this); }
      close() {}
      open() { this.onopen(); }
      output(data, offset, reset = false) {
        this.onmessage({ data: JSON.stringify({ type: "output", data, offset, reset }) });
      }
    }
    const modules = {
      react: {
        useCallback: (fn) => fn,
        useEffect: (fn) => effects.push(fn),
        useRef: (value) => ({ current: firstRef ? (firstRef = false, container) : value }),
        useState: (value) => [value, () => {}],
      },
      "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
      "@xterm/addon-fit": { FitAddon: class { fit() {} } },
      "@xterm/xterm": { Terminal: FakeTerminal },
      "@/hooks/useChatAppearance": { terminalFontSize: () => 14, useChatAppearance: () => ({ fontSize: 14 }) },
      "@/hooks/useI18n": { useI18n: () => ({ t: (key) => key }) },
      "@/hooks/useTerminalTheme": { useTerminalTheme: () => "dark" },
      "@/hooks/useFontPreferences": { subscribeFontPreferences: () => () => {} },
      "@/lib/font-preferences": { readFontWeight: () => 400 },
      "@/lib/terminal-client": terminalClient,
      "@/lib/terminal-extra-keys": {
        NO_TERMINAL_MODIFIERS: { ctrl: false, alt: false },
        applyTerminalModifiers: (data) => data,
      },
      "@/lib/terminal-theme": { TERMINAL_XTERM_THEMES: { dark: {} } },
      "./TerminalExtraKeys": { useTerminalExtraKeysVisible: () => false },
    };
    const exports = {};
    runInNewContext(outputText, {
      exports,
      require: (id) => {
        if (!(id in modules)) throw new Error(`Unexpected module: ${id}`);
        return modules[id];
      },
      EventSource: FakeEventSource,
      ResizeObserver: class { observe() {} disconnect() {} },
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
      navigator: { onLine: true },
      window: { addEventListener() {}, removeEventListener() {} },
    });
    exports.TerminalPanel({ tab: { id: restored ? "restored" : "fresh", cwd: "/tmp", restored }, active: true });
    const cleanup = effects[0]();
    await setImmediate();
    return { stream: streams[0], renders, terminal, cleanup };
  }

  const fresh = await mount(false);
  fresh.stream.open();
  fresh.stream.output("\x1b[>c", 4, true);
  fresh.renders.shift()();
  await setImmediate();
  assert.deepEqual(requests.filter((request) => request.type === "input").map((request) => request.data), ["reply"]);

  // EventSource reconnects automatically on the same instance.
  fresh.stream.open();
  fresh.stream.output("\x1b[>c", 8);
  fresh.renders.shift()();
  await setImmediate();
  assert.equal(requests.filter((request) => request.type === "input").length, 1);
  fresh.stream.output("\x1b[>c", 12);
  fresh.renders.shift()();
  await setImmediate();
  assert.equal(requests.filter((request) => request.type === "input").length, 2);
  // An empty resume snapshot at the current offset is not live output.
  fresh.stream.open();
  fresh.stream.output("", 12);
  fresh.stream.output("\x1b[>c", 16);
  fresh.renders.shift()();
  await setImmediate();
  assert.equal(requests.filter((request) => request.type === "input").length, 3);
  // A cursor older than the bounded backlog causes a reset and history replay.
  fresh.stream.open();
  fresh.stream.output("\x1b[>c", 20, true);
  fresh.renders.shift()();
  await setImmediate();
  assert.equal(requests.filter((request) => request.type === "input").length, 3);
  fresh.cleanup();

  const restored = await mount(true);
  restored.stream.open();
  restored.stream.output("\x1b[>c", 4, true);
  restored.renders.shift()();
  await setImmediate();
  assert.equal(requests.filter((request) => request.type === "input").length, 3);
  restored.terminal.onInput("typed");
  await setImmediate();
  assert.deepEqual(requests.filter((request) => request.type === "input").map((request) => request.data), ["reply", "reply", "reply", "typed"]);
  restored.cleanup();
});
