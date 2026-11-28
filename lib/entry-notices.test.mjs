import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { findMetadataNotices, findTranscriptNotices } = await jiti.import("./entry-notices.ts");

const message = (id, parentId, role) => ({
  type: "message", id, parentId, timestamp: "t",
  message: role === "user"
    ? { role, content: "hi", timestamp: 1 }
    : { role, provider: "p", model: "m", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: 2 },
});
const usage = (id, parentId, purpose = "title") => ({
  type: "model_usage", id, parentId, timestamp: "t", purpose, api: "a", provider: "anthropic", model: "haiku",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, stopReason: "stop",
});
const change = (id, parentId, fields) => ({ id, parentId, timestamp: "t", ...fields });

test("a change follows the message before it; one before the first message has nothing to hang on", () => {
  const entries = [
    change("m0", null, { type: "model_change", model: "p/first" }),
    message("u1", "m0", "user"),
    message("a1", "u1", "assistant"),
    change("m1", "a1", { type: "model_change", model: "p/second", role: "smol" }),
    change("t1", "m1", { type: "thinking_level_change", thinkingLevel: "high", configured: "auto" }),
    change("s1", "t1", { type: "service_tier_change", serviceTier: { openai: "priority" } }),
    message("u2", "s1", "user"),
  ];
  const notices = Object.fromEntries(findMetadataNotices(entries, "u2"));
  assert.deepEqual(notices, {
    a1: [
      { kind: "model_change", model: "p/second", role: "smol" },
      { kind: "thinking_level_change", level: "auto" },
      { kind: "service_tier_change", serviceTier: { openai: "priority" } },
    ],
  });
});

test("model usage follows the message it started from, and nothing off the active branch", () => {
  const entries = [
    message("u1", null, "user"),
    usage("g1", "u1", "title"),
    message("a1", "u1", "assistant"),
    usage("g2", "a1", "cache-warm"),
    message("u2", "a1", "user"),
    message("a2b", "a1", "assistant"),
    usage("g3", "a2b", "cache-warm"),
  ];
  const notices = Object.fromEntries(findMetadataNotices(entries, "u2"));
  assert.deepEqual(notices, {
    u1: [{ kind: "model_usage", purpose: "title", model: "anthropic/haiku", totalTokens: 15 }],
    a1: [{ kind: "model_usage", purpose: "cache-warm", model: "anthropic/haiku", totalTokens: 15 }],
  });
});

test("an empty tier is how the session went back to the default", () => {
  const entries = [message("u1", null, "user"), change("s1", "u1", { type: "service_tier_change", serviceTier: null })];
  assert.deepEqual(findMetadataNotices(entries, "s1").get("u1"), [{ kind: "service_tier_change", serviceTier: {} }]);
});

test("findTranscriptNotices carries the entries beside the conversation, and nothing without a leaf", () => {
  const entries = [
    message("u1", null, "user"),
    message("a1", "u1", "assistant"),
    usage("g1", "a1", "cache-warm"),
  ];
  assert.deepEqual(findTranscriptNotices(entries, "a1").get("a1")?.map((notice) => notice.kind), ["model_usage"]);
  assert.equal(findTranscriptNotices(entries, null).size, 0);
});
