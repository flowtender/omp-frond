import assert from "node:assert/strict";
import fs, { existsSync, readFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const baseAgentDir = await mkdtemp(join(tmpdir(), "pi-web-delete-route-base-"));
const previousAgentDir0 = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = baseAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
// The SDK freezes its dirs resolver at module evaluation: the delete route is
// re-imported inside scratchAgentDir (moduleCache:false) so its whole graph
// evaluates with PI_CODING_AGENT_DIR pointed at the per-test scratch dir.
let deleteSessionsRoute;
const { MAX_SESSION_DELETE_IDS } = await jiti.import("../../../lib/session-delete.ts");
const { PROJECT_DELETE_IDS_PER_REQUEST } = await jiti.import("../../../lib/sidebar-actions.ts");
const { refreshDirsFromEnv } = await jiti.import("@oh-my-pi/pi-utils");
const { serializeTitleSlot } = await jiti.import("@oh-my-pi/pi-coding-agent/session/session-title-slot");
const { invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");
const {
  readSessionUiState,
  resetSessionUiStateCacheForTests,
  updateSessionUiState,
} = await jiti.import("../../../lib/session-ui-state.ts");
const { writeSessionDraft } = await jiti.import("../../../lib/session-draft-store.ts");

test.after(async () => {
  if (previousAgentDir0 === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir0;
  await rm(baseAgentDir, { recursive: true, force: true });
});

const JSON_HEADERS = { host: "localhost", "Content-Type": "application/json" };
const TIME = "2026-10-01T00:00:00.000Z";

function post(body, headers = JSON_HEADERS) {
  return deleteSessionsRoute(new Request("http://localhost/api/sessions/delete", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

/** A legacy or omp title-slot session, with pi-web metadata for subagents. */
async function writeSession(dir, name, { id, cwd, parentSession, subagentOf, titled = false }) {
  const path = join(dir, `${name}.jsonl`);
  const lines = [{ type: "session", version: 3, id, timestamp: TIME, cwd, ...(parentSession ? { parentSession } : {}) }];
  if (subagentOf) {
    lines.push({
      type: "custom",
      customType: "pi-web:subagent",
      id: `${id}-meta`,
      parentId: null,
      timestamp: TIME,
      data: { version: 1, parentSessionId: subagentOf.id, parentSessionPath: subagentOf.path, profile: "Explore", description: "Look around" },
    });
  }
  lines.push(
    { type: "message", id: `${id}-u`, parentId: lines.at(-1).id ?? null, timestamp: TIME, message: { role: "user", content: `hello ${name}`, timestamp: Date.parse(TIME) } },
    { type: "message", id: `${id}-a`, parentId: `${id}-u`, timestamp: TIME, message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.parse(TIME) } },
  );
  const slot = titled ? serializeTitleSlot({ title: `title ${name}`, updatedAt: TIME }) : "";
  await writeFile(path, `${slot}${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

async function scratchAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__ompSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  refreshDirsFromEnv();
  globalThis.__ompSessions = new Map();
  deleteSessionsRoute = (await jiti.import("../../../worker/api/sessions/delete/route.ts")).POST;
  invalidateSessionListCache();
  resetSessionUiStateCacheForTests();
  const ids = [];
  t.after(async () => {
    globalThis.__ompSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    refreshDirsFromEnv();
    for (const id of ids) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    resetSessionUiStateCacheForTests();
    await rm(dir, { recursive: true, force: true });
  });
  const sessionsDir = join(dir, "sessions", "--work-alpha--");
  await mkdir(sessionsDir, { recursive: true });
  return { dir, sessionsDir, ids };
}

test("deletes a project's sessions in one request, with their subagents, keeping a run and re-pointing what stays", async (t) => {
  const { dir, sessionsDir, ids } = await scratchAgentDir(t);
  const cwd = "/work/alpha";
  const keepRoot = await writeSession(sessionsDir, "keep-root", { id: "keep-root", cwd, titled: true });
  const a = await writeSession(sessionsDir, "a", { id: "del-a", cwd, parentSession: keepRoot, titled: true });
  const b = await writeSession(sessionsDir, "b", { id: "del-b", cwd, parentSession: a, titled: true });
  const aSub = await writeSession(sessionsDir, "a-sub", { id: "del-a-sub", cwd, parentSession: a, subagentOf: { id: "del-a", path: a }, titled: true });
  // A fork of b that the confirmation did not count stays re-pointed.
  const keepFork = await writeSession(sessionsDir, "keep-fork", { id: "keep-fork", cwd, parentSession: b, titled: true });
  const forkSlot = readFileSync(keepFork).subarray(0, 256);
  const running = await writeSession(sessionsDir, "running", { id: "run-x", cwd });
  ids.push("keep-root", "del-a", "del-b", "del-a-sub", "keep-fork", "run-x");

  const shutdowns = [];
  const sessionNameFor = { "del-b": "b", "run-x": "running" };
  const wrapper = (id, isRunning) => {
    const sessionFile = join(sessionsDir, `${sessionNameFor[id]}.jsonl`);
    return {
      sessionId: id,
      runtimeId: id,
      sessionFile,
      cwd,
      isAlive: () => true,
      isRunning: () => isRunning,
      isAwaitingInput: () => false,
      inner: { sessionManager: {
        getHeader: () => ({ timestamp: TIME, cwd, id }),
        getEntries: () => [
          { type: "message", timestamp: TIME, message: { role: "user", content: `hello ${id}`, timestamp: Date.parse(TIME) } },
        ],
        getSessionFile: () => sessionFile,
        getSessionName: () => undefined,
      } },
      shutdown: async () => { shutdowns.push(id); globalThis.__ompSessions.delete(id); },
    };
  };
  // run-x started running after the confirmation; del-b is open and idle.
  globalThis.__ompSessions.set("run-x", wrapper("run-x", true));
  globalThis.__ompSessions.set("del-b", wrapper("del-b", false));
  await updateSessionUiState({ action: "set", ids: ["del-a", "keep-root"], pinned: true });
  await updateSessionUiState({ action: "set", ids: ["del-b"], archived: true });

  // Unsent drafts of the deleted sessions (subagents included) go with them; a kept session keeps its draft.
  for (const id of ["del-a", "del-a-sub", "del-b"]) writeSessionDraft(id, { value: "unsent", images: [] }, dir);
  writeSessionDraft("keep-root", { value: "kept", images: [] }, dir);

  const response = await post({ ids: ["del-a", "del-b", "run-x", "gone-elsewhere"] });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const result = await response.json();
  assert.deepEqual(result.deleted.toSorted(), ["del-a", "del-a-sub", "del-b"]);
  assert.deepEqual(result.running, ["run-x"]);
  assert.deepEqual(result.missing, ["gone-elsewhere"]);
  for (const path of [a, b, aSub]) assert.equal(existsSync(path), false, path);
  for (const path of [keepRoot, keepFork, running]) assert.equal(existsSync(path), true, path);
  for (const id of ["del-a", "del-a-sub", "del-b"]) assert.equal(existsSync(join(dir, "pi-web-drafts", `${id}.json`)), false, `${id} draft`);
  assert.equal(existsSync(join(dir, "pi-web-drafts", "keep-root.json")), true);
  // The running session was left alone; the idle one was shut down before its file went.
  assert.deepEqual(shutdowns, ["del-b"]);
  assert.ok(globalThis.__ompSessions.has("run-x"));

  const forkBytes = readFileSync(keepFork);
  assert.deepEqual(forkBytes.subarray(0, 256), forkSlot);
  const forkHeader = JSON.parse(forkBytes.toString("utf8").split("\n")[1]);
  assert.equal(forkHeader.parentSession, keepRoot);
  // Pins and archive times go with the sessions; the others stay.
  assert.deepEqual(Object.keys(readSessionUiState().sessions), ["keep-root"]);
});

test("what stays is re-pointed at its nearest ancestor left, or loses a parent none of whose ancestors stay", async (t) => {
  const { sessionsDir, ids } = await scratchAgentDir(t);
  const cwd = "/work/alpha";
  const root = await writeSession(sessionsDir, "root", { id: "del-root", cwd });
  const middle = await writeSession(sessionsDir, "middle", { id: "keep-middle", cwd, parentSession: root, titled: true });
  const child = await writeSession(sessionsDir, "child", { id: "del-child", cwd, parentSession: middle, titled: true });
  const grandchild = await writeSession(sessionsDir, "grandchild", { id: "keep-grandchild", cwd, parentSession: child, titled: true });
  // A subagent of keep-middle whose header names the deleted child.
  const sub = await writeSession(sessionsDir, "sub", { id: "keep-sub", cwd, parentSession: child, subagentOf: { id: "keep-middle", path: middle }, titled: true });
  const subSlot = readFileSync(sub).subarray(0, 256);
  ids.push("del-root", "keep-middle", "del-child", "keep-grandchild", "keep-sub");

  const result = await (await post({ ids: ["del-root", "del-child"] })).json();

  assert.deepEqual(result.deleted.toSorted(), ["del-child", "del-root"]);
  assert.equal(existsSync(root) || existsSync(child), false);
  const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.type !== "title");
  // Nothing above the deleted root stays: the header loses its parent.
  assert.equal("parentSession" in lines(middle)[0], false);
  assert.equal(lines(grandchild)[0].parentSession, middle);
  const [subHeader, subMeta, ...subRest] = lines(sub);
  assert.equal(subHeader.parentSession, middle);
  assert.deepEqual([subMeta.data.parentSessionId, subMeta.data.parentSessionPath], ["keep-middle", middle]);
  assert.deepEqual(readFileSync(sub).subarray(0, 256), subSlot);
  assert.equal(subRest.length, 2, "the rest of the file is kept");
});

for (const operation of ["single", "bulk"]) {
  async function removeParent(id) {
    if (operation === "bulk") return post({ ids: [id] });
    const { DELETE } = await jiti.import("../../../worker/api/sessions/[id]/route.ts");
    return DELETE(new Request(`http://localhost/api/sessions/${id}`, {
      method: "DELETE", headers: { host: "localhost" },
    }), { params: Promise.resolve({ id }) });
  }

  for (const titled of [false, true]) test(`${operation} delete atomically reparents a ${titled ? "title-slot" : "legacy"} transcript without changing its remaining bytes`, async (t) => {
    const { dir, sessionsDir, ids } = await scratchAgentDir(t);
    const cwd = "/work/alpha";
    const id = `parent-${operation}`;
    const parent = await writeSession(sessionsDir, id, { id, cwd, titled });
    const childId = `child-${operation}`;
    const child = await writeSession(sessionsDir, childId, { id: childId, cwd, parentSession: parent, titled });
    ids.push(id, childId);
    const original = readFileSync(child, "utf8").split("\n");
    const slot = titled ? Buffer.from(`${original[0]}\n`) : Buffer.alloc(0);
    const header = JSON.parse(original[titled ? 1 : 0]);
    header.sdkFutureField = { nested: ["untouched", 42] };
    const tail = Buffer.from('\r\n{ "type": "note", "text": "café" }\r\n\n{"partial":');
    const before = Buffer.concat([slot, Buffer.from(JSON.stringify(header)), tail, Buffer.from([0xff])]);
    await writeFile(child, before);
    let target = child;
    if (process.platform !== "win32") {
      target = join(dir, "linked-transcript");
      await rename(child, target);
      await symlink(target, child);
      await chmod(target, 0o660);
    }
    const oldInode = join(dir, "original-transcript");
    await link(target, oldInode);

    const response = await removeParent(id);
    assert.equal(response.status, 200);
    assert.equal(existsSync(parent), false);
    assert.deepEqual(readFileSync(oldInode), before, "the original inode was not overwritten");
    delete header.parentSession;
    assert.deepEqual(readFileSync(child), Buffer.concat([slot, Buffer.from(JSON.stringify(header)), tail, Buffer.from([0xff])]));
    if (target !== child) {
      assert.equal((await lstat(child)).isSymbolicLink(), true);
      assert.equal((await stat(target)).mode & 0o777, 0o660);
    }
  });

  test(`${operation} delete keeps parent and child intact if the replacement fails`, {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, async (t) => {
    const { dir, sessionsDir, ids } = await scratchAgentDir(t);
    const cwd = "/work/alpha";
    const id = `failed-${operation}`;
    const parent = await writeSession(sessionsDir, id, { id, cwd });
    const childId = `survivor-${operation}`;
    const child = await writeSession(sessionsDir, childId, { id: childId, cwd, parentSession: parent });
    ids.push(id, childId);
    const before = readFileSync(child);
    // The transcript itself is writable and the parent can be unlinked, but
    // the child's directory refuses a replacement. No filesystem mock.
    const locked = join(dir, "read-only-directory");
    const target = join(locked, "transcript");
    await mkdir(locked);
    await rename(child, target);
    await symlink(target, child);
    await chmod(locked, 0o555);
    try {
      const response = await removeParent(id);
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, /EACCES/);
    } finally {
      await chmod(locked, 0o755);
    }
    assert.deepEqual(readFileSync(child), before);
    assert.equal(existsSync(parent), true);
    assert.deepEqual(fs.readdirSync(locked), ["transcript"]);
    assert.deepEqual(fs.readdirSync(sessionsDir).sort(), [`${id}.jsonl`, `${childId}.jsonl`].sort());
  });
}

test("a delete request must be a trusted JSON list of session ids, at most one part", async (t) => {
  await scratchAgentDir(t);
  assert.equal(MAX_SESSION_DELETE_IDS, PROJECT_DELETE_IDS_PER_REQUEST, "the sidebar's parts fit the route");

  assert.equal((await post({ ids: ["a"] }, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post({ ids: ["a"] }, { host: "evil.example", "Content-Type": "application/json" })).status, 403);
  for (const body of ["{", [], { ids: [] }, { ids: "a" }, { ids: ["../a"] }, { ids: [1] }, { ids: Array.from({ length: MAX_SESSION_DELETE_IDS + 1 }, (_, index) => `s${index}`) }]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(typeof (await response.json()).error, "string");
  }
  // Ids already gone delete nothing and say so.
  const response = await post({ ids: ["nobody", "nobody"] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: [], missing: ["nobody"], running: [] });
});
