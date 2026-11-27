import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GET as relay } from "../app/api/[...workerPath]/route.ts";
import { encodeFilePathForApi } from "../lib/file-paths.ts";
import { requestWorker, WorkerUnavailableError } from "../lib/worker-client.ts";

const entry = fileURLToPath(new URL("./main.ts", import.meta.url));

async function startWorker(root, workerId, children, { withForm = false, restricted = false } = {}) {
  const home = join(root, workerId);
  const agentDir = join(home, "agent");
  const cwd = join(home, "project");
  const sessionsDir = join(agentDir, "sessions", "project");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(agentDir, "models.yml"), JSON.stringify({
    providers: {
      test: {
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-only-key",
        api: "openai-completions",
        models: [{ id: `${workerId}-model`, name: `${workerId} model` }],
      },
    },
  }));
  const timestamp = new Date().toISOString();
  const sessionId = randomUUID();
  await writeFile(join(sessionsDir, `${sessionId}.jsonl`), [
    { type: "session", version: 3, id: sessionId, cwd, timestamp },
    { type: "message", id: "deadbeef", parentId: null, timestamp, message: { role: "user", content: "hello", timestamp: Date.now() } },
    "",
  ].map((value) => value ? JSON.stringify(value) : "").join("\n"));
  if (withForm) {
    const directory = join(agentDir, "extensions");
    await mkdir(directory);
    await writeFile(join(directory, "worker-form.ts"), `
      export default function(pi) {
        pi.registerCommand("worker-form", {
          async handler(args, ctx) {
            const result = await ctx.ui.formDialog(
              '<form><label>Answer <input name="answer" type="text"></label></form>',
            );
            if (result) {
              await pi.sendMessage({ customType: "worker-form", content: String(result.data.answer), display: true });
            }
          },
        });
      }
    `);
  }

  const token = randomBytes(32).toString("hex");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: agentDir,
    OMP_FROND_WORKER_ID: workerId,
    OMP_FROND_WORKER_TOKEN: token,
    ...(restricted ? { OMP_FROND_WORKER_WORKSPACE: cwd } : {}),
  };
  const child = spawn(process.execPath, ["--no-env-file", entry], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  children.push({ child, exited });
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
    return { endpoint: { ...JSON.parse(line), token }, sessionId, env, cwd, child, exited };
  } finally {
    lines.close();
  }
}

async function listWorkerModels(endpoint, cwd, signal) {
  const query = new URLSearchParams({ cwd });
  const response = await requestWorker(endpoint, new Request(`http://localhost/api/models?${query}`, { signal }));
  return { status: response.status, data: await response.json() };
}

async function readEvent(stream, predicate) {
  let pending = stream.pending;
  while (true) {
    const split = pending.indexOf("\n\n");
    if (split !== -1) {
      const frame = pending.slice(0, split);
      pending = pending.slice(split + 2);
      if (frame.startsWith("data: ")) {
        const event = JSON.parse(frame.slice(6));
        if (predicate(event)) {
          stream.pending = pending;
          return event;
        }
      }
    } else {
      const chunk = await stream.reader.read();
      assert.equal(chunk.done, false, "stream ended before the expected event");
      pending += stream.decoder.decode(chunk.value, { stream: true });
    }
  }
}

async function openEvents(origin, runtimeId) {
  const res = await fetch(`${origin}/api/agent/${encodeURIComponent(runtimeId)}/events`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/event-stream/);
  return { reader: res.body.getReader(), decoder: new TextDecoder(), pending: "" };
}

test("the private control channel reads models in the selected SDK worker and fails closed", { timeout: 25_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omp-frond-workers-")));
  const children = [];
  try {
    const alpha = await startWorker(root, "alpha", children);
    const beta = await startWorker(root, "beta", children, { restricted: true });
    const duplicate = Bun.spawn([process.execPath, "--no-env-file", entry], {
      cwd: alpha.cwd, env: alpha.env, stdout: "ignore", stderr: "pipe",
    });
    try {
      assert.match(await new Response(duplicate.stderr).text(), /Another frond SDK worker already owns this agent home/);
      assert.notEqual(await duplicate.exited, 0);
    } finally {
      duplicate.kill();
    }
    const signal = AbortSignal.timeout(5_000);
    for (const { endpoint, cwd } of [alpha, beta]) {
      const result = await listWorkerModels(endpoint, cwd, signal);
      assert.equal(result.status, 200);
      assert.deepEqual(result.data.modelList.map(({ provider, id }) => `${provider}:${id}`), [`test:${endpoint.workerId}-model`]);
    }
    assert.deepEqual(await listWorkerModels(alpha.endpoint, beta.cwd, signal), {
      status: 403, data: { error: "Access denied" },
    });
    await assert.rejects(listWorkerModels({ ...alpha.endpoint, token: beta.endpoint.token }, alpha.cwd, signal), WorkerUnavailableError);
    await assert.rejects(listWorkerModels({ ...alpha.endpoint, workerId: "beta" }, alpha.cwd, signal), WorkerUnavailableError);
    const otherFile = join(alpha.cwd, "other-worker.txt");
    const ownFile = join(beta.cwd, "same-worker.txt");
    await Promise.all([writeFile(otherFile, "outside"), writeFile(ownFile, "inside")]);
    const file = (path) => requestWorker(beta.endpoint,
      new Request(`http://localhost/api/files/${encodeFilePathForApi(path)}?type=download`, { signal }));
    assert.equal((await file(otherFile)).status, 403);
    const opened = await file(ownFile);
    assert.equal(opened.status, 200);
    assert.equal(await opened.text(), "inside");
    for (const path of ["/api/cwd/validate", "/api/terminal"]) {
      const denied = await requestWorker(beta.endpoint, new Request(`http://localhost${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: alpha.cwd }), signal,
      }));
      assert.equal(denied.status, 403);
    }

    alpha.child.kill();
    const alphaExit = await alpha.exited;
    if (process.platform !== "win32") assert.deepEqual(alphaExit, [0, null]);
    await assert.rejects(listWorkerModels(alpha.endpoint, alpha.cwd, signal), WorkerUnavailableError);
    assert.equal((await listWorkerModels(beta.endpoint, beta.cwd, signal)).status, 200);
  } finally {
    for (const { child } of children) child.kill();
    await Promise.allSettled(children.map(({ exited }) => exited));
    await rm(root, { recursive: true, force: true });
  }
});

test("replacing the web relay does not replay a prompt or lose a pending extension form", { timeout: 20_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omp-frond-worker-reconnect-")));
  const children = [];
  const controlKeys = ["OMP_FROND_WORKER_ID", "OMP_FROND_WORKER_PORT", "OMP_FROND_WORKER_TOKEN"];
  const savedEnv = controlKeys.map((key) => process.env[key]);
  let web;
  let firstStream;
  let secondStream;
  try {
    const worker = await startWorker(root, "local", children, { withForm: true });
    const { endpoint, sessionId } = worker;
    process.env.OMP_FROND_WORKER_ID = endpoint.workerId;
    process.env.OMP_FROND_WORKER_PORT = String(endpoint.port);
    process.env.OMP_FROND_WORKER_TOKEN = endpoint.token;

    const startWeb = (port = 0) => Bun.serve({
      hostname: "127.0.0.1", port, idleTimeout: 0, fetch: relay,
    });
    const command = async (id, body) => {
      const res = await fetch(`${web.url}api/agent/${encodeURIComponent(id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
      });
      const result = await res.json();
      assert.equal(res.status, 200, JSON.stringify(result));
      return result;
    };

    web = startWeb();
    const port = web.port;
    firstStream = await openEvents(web.url.origin, sessionId);
    const connected = await readEvent(firstStream, (event) => event.type === "connected");
    const runtimeId = connected.runtimeId;
    assert.equal(connected.sessionId, sessionId);
    assert.equal(connected.isStreaming, false);
    const started = await command(runtimeId, { type: "prompt", message: "/worker-form" });
    assert.equal(started.runtimeId, runtimeId);
    const form = await readEvent(firstStream, (event) => event.type === "extension_ui_request" && event.method === "form");

    await web.stop(true);
    web = startWeb(port);
    secondStream = await openEvents(web.url.origin, runtimeId);
    const recovered = await readEvent(secondStream, (event) => event.type === "connected");
    assert.equal(recovered.runtimeId, runtimeId);
    assert.equal(recovered.sessionId, sessionId);
    assert.equal(recovered.isStreaming, true);
    assert.deepEqual(recovered.pendingExtensionUiIds, [form.id]);
    assert.equal((await readEvent(secondStream, (event) => event.type === "extension_ui_request")).id, form.id);
    await command(runtimeId, {
      type: "extension_ui_response", id: form.id,
      value: JSON.stringify({ choices: {}, texts: { answer: "recovered answer" } }),
    });
    await readEvent(secondStream, (event) => event.type === "prompt_done");

    await command(runtimeId, { type: "prompt", message: "/worker-form cancel" });
    const cancelled = await readEvent(secondStream, (event) => event.type === "extension_ui_request" && event.method === "form");
    await command(runtimeId, { type: "abort" });
    await readEvent(secondStream, (event) => event.type === "extension_ui_closed" && event.id === cancelled.id);
    await readEvent(secondStream, (event) => event.type === "prompt_done");
    const transcript = await fetch(`${web.url}api/sessions/${sessionId}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(transcript.status, 200);
    const { context } = await transcript.json();
    assert.deepEqual(context.messages.filter((message) => message.customType === "worker-form").map((message) => message.content),
      ["recovered answer"]);

    worker.child.kill();
    const workerExit = await worker.exited;
    if (process.platform !== "win32") assert.deepEqual(workerExit, [0, null]);
    const unavailable = await fetch(`${web.url}api/agent/${encodeURIComponent(runtimeId)}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, "worker_unavailable");
  } finally {
    await web?.stop(true);
    await firstStream?.reader.cancel().catch(() => {});
    await secondStream?.reader.cancel().catch(() => {});
    for (const { child } of children) child.kill();
    await Promise.allSettled(children.map(({ exited }) => exited));
    for (const [index, key] of controlKeys.entries()) {
      if (savedEnv[index] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[index];
    }
    await rm(root, { recursive: true, force: true });
  }
});
