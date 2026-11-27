import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { inferPromptCacheEntry, readSavedPromptCacheState } = await jiti.import("./prompt-cache.ts");
const { parsePromptCacheIndicatorSettings, promptCacheViewAt, visiblePromptCacheInfo } = await jiti.import("./prompt-cache-shared.ts");
const { promptCacheStatus } = await jiti.import("@oh-my-pi/pi-coding-agent/session/prompt-cache-status");

const dir = await mkdtemp(join(tmpdir(), "omp-frond-prompt-cache-"));
after(() => rm(dir, { recursive: true, force: true }));

const SHORT_TTL_S = 300;
const models = {
  "anthropic/claude-a": { provider: "anthropic", id: "claude-a", name: "Claude A", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", promptCache: { short: SHORT_TTL_S } },
  "anthropic/claude-b": { provider: "anthropic", id: "claude-b", name: "Claude B", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", promptCache: { short: SHORT_TTL_S } },
};
const registry = {
  find: (provider, id) => models[`${provider}/${id}`],
  isUsingOAuth: () => false,
};

function usage({ cacheRead = 0, cacheWrite = 0 } = {}) {
  return {
    input: 10, output: 5, cacheRead, cacheWrite, totalTokens: 15 + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A v3 transcript; each entry's parent is the one before it unless it names its own. */
function transcript(cwd, entries) {
  const lines = [{ type: "session", version: 3, id: "session-1", timestamp: new Date(0).toISOString(), cwd }];
  let previousId = null;
  entries.forEach((entry, index) => {
    const id = entry.id ?? `e${index}`;
    lines.push({ timestamp: new Date(0).toISOString(), ...entry, id, parentId: entry.parentId === undefined ? previousId : entry.parentId });
    previousId = id;
  });
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

const modelChange = (model) => ({ type: "model_change", model, role: "default" });
const user = (text, extra = {}) => ({ type: "message", ...extra, message: { role: "user", content: text, timestamp: 0 } });
const reply = (timestamp, cache, extra = {}) => ({
  type: "message",
  ...extra,
  message: {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-a",
    usage: usage(cache),
    stopReason: "stop",
    timestamp,
  },
});
const warmRefresh = (sentAt, hit) => ({
  type: "model_usage", purpose: "cache-warm", api: "anthropic-messages", provider: "anthropic", model: "claude-a",
  usage: usage({ cacheRead: hit ? 1000 : 0 }), stopReason: "stop", cacheRefresh: { sentAt, hit },
});

let fileIndex = 0;
async function inferFrom(entries, retention = "auto") {
  const file = join(dir, `session-${fileIndex++}.jsonl`);
  await writeFile(file, transcript(dir, entries));
  const { state } = await readSavedPromptCacheState(file);
  return inferPromptCacheEntry(state, registry, retention);
}

test("reads the cache entry off the active branch, not the newest reply in the file", async () => {
  const entry = await inferFrom([
    modelChange("anthropic/claude-a"),
    user("first", { id: "u1" }),
    reply(1_000, { cacheWrite: 1_000 }, { id: "a1" }),
    user("second"),
    reply(5_000, { cacheRead: 1_000 }),
    // Rewound to a1: a new turn whose reply never touched the cache.
    user("instead", { parentId: "a1" }),
    reply(7_000, {}),
  ]);
  assert.equal(entry.touchedAt, 1_000);
  assert.equal(entry.ttlMs, SHORT_TTL_S * 1000);
  assert.equal(entry.change, undefined);
});

test("a warm refresh that hit restarts the lifetime; one that missed marks the entry cold", async () => {
  const hit = await inferFrom([modelChange("anthropic/claude-a"), user("hi"), reply(1_000, { cacheWrite: 1_000 }), warmRefresh(200_000, true)]);
  assert.equal(hit.touchedAt, 200_000);
  assert.equal(promptCacheStatus(hit, { nowMs: 200_000 + 1, nextTokens: 0 }).state, "warm");

  const missed = await inferFrom([modelChange("anthropic/claude-a"), user("hi"), reply(1_000, { cacheWrite: 1_000 }), warmRefresh(200_000, false)]);
  const status = promptCacheStatus(missed, { nowMs: 2_000, nextTokens: 0 });
  assert.equal(status.state, "cold");
  assert.deepEqual(status.reason, { kind: "refresh-missed" });
});

test("a model switch or a compaction after the cached reply means the next message cannot read it", async () => {
  const switched = await inferFrom([modelChange("anthropic/claude-a"), user("hi"), reply(1_000, { cacheWrite: 1_000 }), modelChange("anthropic/claude-b")]);
  assert.deepEqual(switched.change, { kind: "model", from: "Claude A", to: "Claude B" });

  const compacted = await inferFrom([
    modelChange("anthropic/claude-a"), user("hi"), reply(1_000, { cacheWrite: 1_000 }),
    { type: "compaction", summary: "s", firstKeptEntryId: "e1", tokensBefore: 10 },
  ]);
  assert.deepEqual(compacted.change, { kind: "compaction" });
});

test("a branch whose replies never used the cache has no entry", async () => {
  assert.equal(await inferFrom([modelChange("anthropic/claude-a"), user("hi"), reply(1_000, {})]), undefined);
});

test("the browser view lapses exactly at expiry and fades before it", () => {
  const info = { state: "warm", inferred: false, tier: "short", touchedAt: 0, ttlMs: 100_000 };
  const nearlyGone = promptCacheViewAt(info, 99_000);
  assert.equal(nearlyGone.state, "warm");
  assert.ok(Math.abs(nearlyGone.remaining - 0.01) < 1e-9);
  assert.deepEqual(promptCacheViewAt(info, 100_000), { state: "cold", inferred: false, reason: { kind: "expired", at: 100_000 } });
  // A refresh in flight keeps it warm until the server reports the outcome.
  assert.equal(promptCacheViewAt({ ...info, warming: { state: "refreshing" } }, 100_000).state, "warm");
  // A provider that never expires entries stays full.
  assert.equal(promptCacheViewAt({ ...info, ttlMs: undefined }, 10 ** 12).remaining, 1);
});

test("a saved timeout expires inferred entries without an omp lifetime", () => {
  const settings = parsePromptCacheIndicatorSettings('{"inferredTimeoutMinutes":30}');
  const touchedAt = 60_000;
  const expiresAt = touchedAt + 30 * 60_000;
  const info = { state: "warm", inferred: true, tier: "short", touchedAt };
  for (const live of [false, true]) {
    const visible = visiblePromptCacheInfo(settings, { live, info });
    assert.equal(promptCacheViewAt(visible, expiresAt - 1).state, "warm");
    assert.deepEqual(promptCacheViewAt(visible, expiresAt), {
      state: "cold", inferred: true, reason: { kind: "expired", at: expiresAt },
    });
  }

  const confirmed = { ...info, inferred: false };
  const knownLifetime = { ...info, ttlMs: 60_000 * 60 };
  assert.equal(promptCacheViewAt(visiblePromptCacheInfo(settings, { live: true, info: confirmed }), expiresAt).expiresAt, undefined);
  assert.equal(promptCacheViewAt(visiblePromptCacheInfo(settings, { live: false, info: knownLifetime }), expiresAt).expiresAt, touchedAt + knownLifetime.ttlMs);
});

test("legacy and invalid saved settings keep omp's lifetime estimate", () => {
  const report = { live: false, info: { state: "warm", inferred: true, tier: "short", touchedAt: 60_000 } };
  for (const raw of ['{"style":"gradient"}', '{"inferredTimeoutMinutes":-1}', '{"inferredTimeoutMinutes":1.5}']) {
    const visible = visiblePromptCacheInfo(parsePromptCacheIndicatorSettings(raw), report);
    assert.equal(promptCacheViewAt(visible, 10 ** 12).expiresAt, undefined);
  }
});
