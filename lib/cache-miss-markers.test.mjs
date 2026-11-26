import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { detectCacheInvalidation } from "@oh-my-pi/pi-coding-agent/session/transcript/cache-invalidation-marker";

const jiti = createJiti(import.meta.url);
const { attachCacheMisses, findCacheMisses, findLiveCacheMiss } = await jiti.import("./cache-miss-markers.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const { formatNoticeTokens, getTranscriptNotices, summarizeCacheMisses } = await jiti.import("./transcript-notices.ts");

const WARM = { input: 50, cacheRead: 40_000, cacheWrite: 600 };
const COLD = { input: 300, cacheRead: 0, cacheWrite: 41_000 };
const COLD_MISS = { kind: "cache_miss", reprocessedTokens: COLD.cacheWrite + COLD.input };

let clock = Date.parse("2026-11-01T10:00:00.000Z");

/** Builds a linear branch: each call appends an entry under the previous one. */
function branch() {
  const entries = [];
  const append = (fields) => {
    clock += 1000;
    const entry = { id: `e${entries.length + 1}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(clock).toISOString(), ...fields };
    entries.push(entry);
    return entry;
  };
  return {
    entries,
    user: (text = "go on") => append({ type: "message", message: { role: "user", content: text, timestamp: clock } }),
    assistant: (usage, model = "opus") => append({ type: "message", message: assistantMessage(usage, model) }),
    append,
  };
}

function assistantMessage({ input = 0, cacheRead = 0, cacheWrite = 0 } = {}, model = "opus") {
  return {
    role: "assistant",
    provider: "anthropic",
    model,
    stopReason: "stop",
    content: [{ type: "text", text: "done" }],
    usage: { input, output: 20, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: clock,
  };
}

const misses = (session) => Object.fromEntries(findCacheMisses(session.entries, session.entries.at(-1).id));

test("marks the turn where a warm prompt cache went cold, as omp's detector measures it", () => {
  const session = branch();
  session.user();
  session.assistant(WARM);
  session.user();
  const cold = session.assistant(COLD);
  assert.deepEqual(misses(session), { [cold.id]: COLD_MISS });
  assert.deepEqual(detectCacheInvalidation(session.entries[1].message.usage, cold.message.usage), { reprocessedTokens: COLD_MISS.reprocessedTokens });
});

test("needs a predecessor that read a warm cache back, measured past turns that used no prompt tokens", () => {
  const writeOnly = branch();
  writeOnly.user();
  writeOnly.assistant({ input: 50, cacheWrite: 40_000 });
  writeOnly.user();
  writeOnly.assistant(COLD);
  assert.deepEqual(misses(writeOnly), {}, "the first write has not proven the cache live");

  const interrupted = branch();
  interrupted.user();
  interrupted.assistant(WARM);
  interrupted.assistant({});
  const cold = interrupted.assistant(COLD);
  assert.deepEqual(misses(interrupted), { [cold.id]: COLD_MISS });
});

test("leaves misses omp explains unmarked: a model change, a compaction or a plan-mode switch", () => {
  for (const reset of [
    { type: "model_change", model: "anthropic/sonnet", role: "default" },
    { type: "compaction", summary: "earlier work", firstKeptEntryId: "e1", tokensBefore: 40_000 },
    { type: "mode_change", mode: "plan" },
  ]) {
    const session = branch();
    session.user();
    session.assistant(WARM);
    session.append(reset);
    session.user();
    session.assistant(COLD);
    assert.deepEqual(misses(session), {}, reset.type);
  }

  const servedByAnotherModel = branch();
  servedByAnotherModel.user();
  servedByAnotherModel.assistant(WARM, "opus");
  servedByAnotherModel.user();
  servedByAnotherModel.assistant(COLD, "sonnet");
  assert.deepEqual(misses(servedByAnotherModel), {});
});

test("the first turn after a /clear has no predecessor, and the next one is measured again", () => {
  const session = branch();
  session.user();
  session.assistant(WARM);
  session.append({ type: "reset_boundary" });
  session.user();
  session.assistant(COLD);
  session.user();
  session.assistant(WARM);
  session.user();
  const cold = session.assistant(COLD);
  assert.deepEqual(misses(session), { [cold.id]: COLD_MISS });
});

test("reads only the branch to the shown leaf", () => {
  const session = branch();
  session.user();
  const fork = session.assistant({ input: 50, cacheWrite: 40_000 });
  session.user();
  session.assistant(WARM);
  // A sibling branch under `fork` never saw the warm read above.
  const sibling = { type: "message", id: "s1", parentId: fork.id, timestamp: new Date(clock).toISOString(), message: assistantMessage(COLD) };
  assert.deepEqual(Object.fromEntries(findCacheMisses([...session.entries, sibling], sibling.id)), {});
  assert.deepEqual(Object.fromEntries(findCacheMisses(session.entries, null)), {});
});

test("hangs each marker on its message, on any history page", () => {
  const session = branch();
  session.user();
  session.assistant(WARM);
  session.user();
  const cold = session.assistant(COLD);
  session.user();
  session.assistant(WARM);
  const leafId = session.entries.at(-1).id;

  const latest = attachCacheMisses(buildSessionContext(session.entries, leafId), findCacheMisses(session.entries, leafId));
  const marked = latest.entryIds.flatMap((id, index) => getTranscriptNotices(latest.messages[index]).length > 0 ? [id] : []);
  assert.deepEqual(marked, [cold.id]);
  assert.equal(getTranscriptNotices(session.entries.at(-3).message).length, 0, "the stored message stays untouched");

  // An older page ends at its own leaf; the turns above it still count.
  const page = attachCacheMisses(
    buildSessionContext(session.entries, cold.id, { tail: 1 }),
    findCacheMisses(session.entries, cold.id),
  );
  assert.deepEqual(page.entryIds, [cold.id]);
  assert.deepEqual(getTranscriptNotices(page.messages[0]), [COLD_MISS]);
});

test("a live reply gets the marker a later history read gives it, whether or not omp saved it yet", () => {
  const session = branch();
  session.user();
  session.assistant(WARM);
  session.user();
  const before = [...session.entries];
  const cold = session.assistant(COLD);

  assert.deepEqual(findLiveCacheMiss(before, before.at(-1).id, cold.message), COLD_MISS);
  assert.deepEqual(findLiveCacheMiss(session.entries, cold.id, cold.message), COLD_MISS);
  assert.equal(findLiveCacheMiss(before.slice(0, 2), before[1].id, assistantMessage(WARM)), undefined);
});

test("formats token counts as omp's formatNumber() and adds a fold's misses up", () => {
  for (const count of [0, 999, 1000, 1500, 9_960, 25_400, 999_499, 1_500_000, 25_000_000, 1_500_000_000, 25_000_000_000]) {
    assert.equal(formatNoticeTokens(count), formatNumber(count), String(count));
  }
  const marked = { role: "assistant", transcriptNotices: [{ kind: "cache_miss", reprocessedTokens: 1200 }] };
  assert.deepEqual(summarizeCacheMisses([marked, { role: "toolResult" }, marked]), { count: 2, reprocessedTokens: 2400 });
  assert.equal(summarizeCacheMisses([{ role: "assistant" }]), undefined);
});
