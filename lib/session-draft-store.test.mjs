import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { forgetSessionDrafts, readSessionDraft, writeSessionDraft } = await jiti.import("./session-draft-store.ts");

const PNG = { data: "aGk=", mimeType: "image/png" };

async function withAgentDir(run) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-session-drafts-"));
  try {
    await run(agentDir);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("a session without a stored draft reads as revision 0 and empty", async () => {
  await withAgentDir((agentDir) => {
    assert.deepEqual(readSessionDraft("s-empty", agentDir), { revision: 0, value: "", images: [] });
  });
});

test("every write bumps the revision and is read back, text and images", async () => {
  await withAgentDir((agentDir) => {
    const first = writeSessionDraft("s-one", { value: "hello", images: [PNG] }, agentDir);
    const second = writeSessionDraft("s-one", { value: "hello again", images: [] }, agentDir);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.deepEqual(readSessionDraft("s-one", agentDir), { revision: 2, value: "hello again", images: [] });
  });
});

test("the draft lives in pi-web-drafts/<id>.json under the agent directory", async () => {
  await withAgentDir(async (agentDir) => {
    writeSessionDraft("s-path", { value: "x", images: [] }, agentDir);
    const stored = JSON.parse(await readFile(path.join(agentDir, "pi-web-drafts", "s-path.json"), "utf8"));
    assert.deepEqual(stored, { revision: 1, value: "x", images: [] });
  });
});

test("clearing keeps the revision moving forward (tombstone, not deletion)", async () => {
  await withAgentDir((agentDir) => {
    writeSessionDraft("s-clear", { value: "unsent", images: [PNG] }, agentDir);
    const cleared = writeSessionDraft("s-clear", { value: "", images: [] }, agentDir);
    assert.deepEqual(cleared, { revision: 2, value: "", images: [] });
    assert.deepEqual(readSessionDraft("s-clear", agentDir), { revision: 2, value: "", images: [] });
  });
});

test("an external edit to the file is picked up on the next read", async () => {
  await withAgentDir(async (agentDir) => {
    writeSessionDraft("s-external", { value: "first", images: [] }, agentDir);
    assert.equal(readSessionDraft("s-external", agentDir).value, "first");
    await writeFile(
      path.join(agentDir, "pi-web-drafts", "s-external.json"),
      JSON.stringify({ revision: 9, value: "edited elsewhere", images: [] }),
    );
    assert.deepEqual(readSessionDraft("s-external", agentDir), { revision: 9, value: "edited elsewhere", images: [] });
  });
});

test("ids that are not session ids never reach the filesystem", async () => {
  await withAgentDir((agentDir) => {
    assert.throws(() => readSessionDraft("../escape", agentDir), /Invalid session id/);
    assert.throws(() => writeSessionDraft("a/b", { value: "x", images: [] }, agentDir), /Invalid session id/);
  });
});

test("an unreadable draft file is reported and never overwritten", async () => {
  await withAgentDir(async (agentDir) => {
    await mkdir(path.join(agentDir, "pi-web-drafts"), { recursive: true });
    const file = path.join(agentDir, "pi-web-drafts", "s-corrupt.json");
    await writeFile(file, "{not json");
    assert.throws(() => readSessionDraft("s-corrupt", agentDir), /unreadable/);
    assert.throws(() => writeSessionDraft("s-corrupt", { value: "x", images: [] }, agentDir), /unreadable/);
    assert.equal(await readFile(file, "utf8"), "{not json");
  });
});

test("a stored file with an invalid shape is reported as unreadable", async () => {
  await withAgentDir(async (agentDir) => {
    await mkdir(path.join(agentDir, "pi-web-drafts"), { recursive: true });
    await writeFile(
      path.join(agentDir, "pi-web-drafts", "s-shape.json"),
      JSON.stringify({ revision: -1, value: "", images: [] }),
    );
    assert.throws(() => readSessionDraft("s-shape", agentDir), /unreadable/);
  });
});

test("forgetting sessions removes their draft files; invalid ids are skipped and a missing file is fine", async () => {
  await withAgentDir((agentDir) => {
    writeSessionDraft("s-forget", { value: "gone soon", images: [PNG] }, agentDir);
    writeSessionDraft("s-keep", { value: "stays", images: [] }, agentDir);
    forgetSessionDrafts(["s-forget", "../escape"], agentDir);
    assert.deepEqual(readSessionDraft("s-forget", agentDir), { revision: 0, value: "", images: [] });
    assert.equal(readSessionDraft("s-keep", agentDir).value, "stays");
    assert.doesNotThrow(() => forgetSessionDrafts(["s-forget"], agentDir));
  });
});
