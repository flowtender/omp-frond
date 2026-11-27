import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { PATCH } from "../../../worker/api/sessions/[id]/route.ts";
import { AgentSessionWrapper, renameRpcSession, startRpcSession } from "../../../lib/rpc-manager.ts";
import { cacheSessionPath, invalidateSessionPathCache } from "../../../lib/session-reader.ts";

async function savedSession(t) {
  const dir = await mkdtemp(join(tmpdir(), "omp-rename-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "first question", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: Date.now() });
  await manager.flush();
  const id = manager.getSessionId();
  const file = manager.getSessionFile();
  cacheSessionPath(id, file);
  t.after(async () => {
    invalidateSessionPathCache(id);
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { id, file, manager };
}

function rename(id, name) {
  return PATCH(new Request(`http://localhost/api/sessions/${id}`, {
    method: "PATCH", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ name }),
  }), { params: Promise.resolve({ id }) });
}

test("a rename during startup follows the live leaf without waiting for a startup dialog", async (t) => {
  const { id, manager, file } = await savedSession(t);
  const locks = globalThis.__ompStartLocks ??= new Map();
  const registry = globalThis.__ompSessions ??= new Map();
  const starting = Promise.withResolvers();
  locks.set(id, starting.promise);
  const response = rename(id, "  Live title  ");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getSessionName(), undefined);
  const dialog = Promise.withResolvers();
  const wrapper = new AgentSessionWrapper({
    sessionId: id, sessionFile: file, sessionManager: manager,
    bindExtensions: () => dialog.promise,
  });
  registry.set(id, wrapper);
  wrapper.beginExtensionBinding();
  locks.delete(id);
  starting.resolve({ session: wrapper, realSessionId: id });
  try {
    assert.equal((await response).status, 200);
    assert.equal(manager.getSessionName(), "Live title");
    const titleLeaf = manager.getLeafId();
    const prompt = manager.appendMessage({ role: "user", content: "next prompt", timestamp: Date.now() });
    await manager.flush();
    const reopened = await SessionManager.open(file);
    try {
      assert.equal(reopened.getSessionName(), "Live title");
      assert.equal(reopened.getLeafId(), prompt);
      assert.equal(reopened.getEntry(prompt).parentId, titleLeaf);
    } finally { await reopened.close(); }
  } finally {
    dialog.resolve();
    await wrapper.shutdown();
  }
});

test("a rename waits for shutdown before writing offline; a concurrent start sees the new title", async (t) => {
  const { id, manager, file } = await savedSession(t);
  await manager.close();
  const registry = globalThis.__ompSessions ??= new Map();
  const waiting = Promise.withResolvers();
  const disposed = Promise.withResolvers();
  registry.set(id, { sessionId: id, isAlive: () => false, waitUntilDisposed() {
    waiting.resolve();
    return disposed.promise;
  } });
  const response = rename(id, "After shutdown");
  await waiting.promise;
  registry.delete(id);
  disposed.resolve(true);
  assert.equal((await response).status, 200);
  const reopened = await SessionManager.open(file);
  assert.equal(reopened.getSessionName(), "After shutdown");
  await reopened.close();

  const writing = renameRpcSession(id, file, "Before start");
  const starting = startRpcSession(id, file, undefined, { toolNames: [] });
  assert.equal(await writing, true);
  const { session } = await starting;
  try { assert.equal(session.inner.sessionManager.getSessionName(), "Before start"); }
  finally { await session.shutdown(); }
});
