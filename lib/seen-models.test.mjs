import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const { markModelsSeen, reconcileSeenModels } = await import("./seen-models.ts");

const tempDirs = [];
async function agentDir() {
  const dir = await mkdtemp(join(tmpdir(), "omp-frond-seen-models-"));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const sorted = (set) => [...set].sort();

test("the first look records every available model, so nothing starts out new", async () => {
  const dir = await agentDir();
  assert.deepEqual(sorted(reconcileSeenModels(dir, ["anthropic/opus", "openai/gpt"])), []);
  assert.deepEqual(sorted(reconcileSeenModels(dir, ["anthropic/opus", "openai/gpt"])), []);
});

test("a model that appears later for a known provider is new until it is marked seen", async () => {
  const dir = await agentDir();
  reconcileSeenModels(dir, ["anthropic/opus"]);
  assert.deepEqual(sorted(reconcileSeenModels(dir, ["anthropic/opus", "anthropic/opus-next"])), ["anthropic/opus-next"]);
  // Still new on the next look: only a switch or a prompt clears it.
  assert.deepEqual(sorted(reconcileSeenModels(dir, ["anthropic/opus", "anthropic/opus-next"])), ["anthropic/opus-next"]);

  markModelsSeen(dir, ["anthropic/opus-next"]);
  assert.deepEqual(sorted(reconcileSeenModels(dir, ["anthropic/opus", "anthropic/opus-next"])), []);
});

test("signing in to a provider does not tag its whole catalog", async () => {
  const dir = await agentDir();
  reconcileSeenModels(dir, ["anthropic/opus"]);
  assert.deepEqual(sorted(reconcileSeenModels(dir, ["anthropic/opus", "openai/gpt", "openai/gpt-mini"])), []);
});

test("a model that goes away and comes back is not new", async () => {
  const dir = await agentDir();
  reconcileSeenModels(dir, ["anthropic/opus", "anthropic/sonnet"]);
  reconcileSeenModels(dir, ["anthropic/opus"]);
  assert.deepEqual(sorted(reconcileSeenModels(dir, ["anthropic/opus", "anthropic/sonnet"])), []);
});

test("an unreadable record starts over instead of tagging everything", async () => {
  const dir = await agentDir();
  await writeFile(join(dir, "omp-frond-seen-models.json"), "{not json");
  assert.deepEqual(sorted(reconcileSeenModels(dir, ["anthropic/opus"])), []);
});
