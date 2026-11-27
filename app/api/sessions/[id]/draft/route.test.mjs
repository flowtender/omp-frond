import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

// The SDK freezes its dirs resolver at module evaluation, so the scratch dir
// is set before the routes and the session tooling are imported.
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-draft-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { refreshDirsFromEnv } = await jiti.import("@oh-my-pi/pi-utils");
refreshDirsFromEnv();
const { invalidateSessionListCache } = await jiti.import("@/lib/session-reader.ts");
const { GET, PUT } = await jiti.import("../../../../../worker/api/sessions/[id]/draft/route.ts");
const { DELETE } = await jiti.import("../../../../../worker/api/sessions/[id]/route.ts");

test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  refreshDirsFromEnv();
  await rm(agentDir, { recursive: true, force: true });
});

const HEADERS = { host: "localhost", "Content-Type": "application/json" };
const IMAGE = { data: "aGVsbG8=", mimeType: "image/png" };

/** A real saved session, as the sidebar lists it: the draft routes refuse anything else. */
async function createSession() {
  const id = randomUUID();
  const cwd = join(agentDir, "project");
  const dir = join(agentDir, "sessions", "--project--");
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  await writeFile(join(dir, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`), [
    { type: "session", version: 3, id, cwd, timestamp },
    { type: "message", id: "00000001", parentId: null, timestamp, message: { role: "user", content: "hello", timestamp: Date.parse(timestamp) } },
    { type: "message", id: "00000002", parentId: "00000001", timestamp, message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.parse(timestamp) } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  invalidateSessionListCache();
  return id;
}

function context(id) {
  return { params: Promise.resolve({ id }) };
}

function get(id, query = "") {
  return GET(new Request(`http://localhost/api/sessions/${id}/draft${query}`, { headers: { host: "localhost" } }), context(id));
}

function put(id, body, headers = HEADERS) {
  return PUT(new Request(`http://localhost/api/sessions/${id}/draft`, {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), context(id));
}

function draftFile(id) {
  return join(agentDir, "pi-web-drafts", `${id}.json`);
}

test("a saved session without a draft reads as revision 0, empty", async () => {
  const id = await createSession();
  const response = await get(id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { revision: 0, unchanged: false, value: "", images: [] });
});

test("PUT stores the draft with its images and answers with the revision only", async () => {
  const id = await createSession();
  const response = await put(id, { value: "hi", images: [IMAGE] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { revision: 1 });

  const read = await (await get(id)).json();
  assert.deepEqual(read, { revision: 1, unchanged: false, value: "hi", images: [IMAGE] });
});

test("GET with since equal to the revision answers unchanged; any other since answers in full", async () => {
  const id = await createSession();
  await put(id, { value: "draft", images: [] });

  assert.deepEqual(await (await get(id, "?since=1")).json(), { revision: 1, unchanged: true });
  assert.deepEqual(await (await get(id, "?since=0")).json(), { revision: 1, unchanged: false, value: "draft", images: [] });
  assert.deepEqual(await (await get(id, "?since=abc")).json(), { revision: 1, unchanged: false, value: "draft", images: [] });
});

test("clearing the draft leaves a tombstone so the revision keeps growing", async () => {
  const id = await createSession();
  await put(id, { value: "typed", images: [] });
  assert.deepEqual(await (await put(id, { value: "", images: [] })).json(), { revision: 2 });
  assert.deepEqual(await (await get(id)).json(), { revision: 2, unchanged: false, value: "", images: [] });
});

test("a missing session answers 404 for read and write, and creates no draft file", async () => {
  const id = "s-route-missing";
  const read = await get(id);
  assert.equal(read.status, 404);
  assert.deepEqual(await read.json(), { error: "Session not found" });

  const write = await put(id, { value: "orphan", images: [] });
  assert.equal(write.status, 404);
  assert.deepEqual(await write.json(), { error: "Session not found" });
  assert.equal(existsSync(draftFile(id)), false);
});

test("requests are refused for an untrusted host, a non-JSON body, an invalid id or body", async () => {
  const id = await createSession();
  assert.equal((await put(id, { value: "x", images: [] }, { host: "evil.example", "Content-Type": "application/json" })).status, 403);
  assert.equal((await put(id, { value: "x", images: [] }, { host: "localhost" })).status, 415);
  assert.equal((await put(id, "{not json")).status, 400);
  assert.equal((await put(id, { value: 3, images: [] })).status, 400);
  assert.equal((await get("bad id!")).status, 400);
  assert.equal(existsSync(draftFile(id)), false);
});

test("a corrupt draft file is reported and never overwritten", async () => {
  const id = await createSession();
  await mkdir(join(agentDir, "pi-web-drafts"), { recursive: true });
  await writeFile(draftFile(id), "{broken");

  assert.equal((await get(id)).status, 500);
  assert.equal((await put(id, { value: "over", images: [] })).status, 500);
  assert.equal(readFileSync(draftFile(id), "utf8"), "{broken");
});

test("deleting the session removes its unsent draft file", async () => {
  const id = await createSession();
  await put(id, { value: "unsent", images: [IMAGE] });
  assert.equal(existsSync(draftFile(id)), true);

  const response = await DELETE(new Request(`http://localhost/api/sessions/${id}`, {
    method: "DELETE",
    headers: { host: "localhost" },
  }), context(id));
  assert.equal(response.status, 200);
  assert.equal(existsSync(draftFile(id)), false);
});
