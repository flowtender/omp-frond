import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const {
  clearExpandedToolCalls,
  countToolCallFailures,
  isToolCallExpanded,
  setToolCallExpanded,
  toolCallExpandedByDefault,
} = await createJiti(import.meta.url).import("./tool-call-expansion.ts");

test("remembers expanded tool calls across remounts by toolCallId", () => {
  clearExpandedToolCalls();
  assert.equal(isToolCallExpanded("call_1"), undefined);

  setToolCallExpanded("call_1", true);
  assert.equal(isToolCallExpanded("call_1"), true);
  assert.equal(isToolCallExpanded("call_2"), undefined);

  setToolCallExpanded("call_1", false);
  assert.equal(isToolCallExpanded("call_1"), false);
});

test("tool defaults expand all, only failures, or nothing", () => {
  for (const failed of [false, true]) {
    assert.equal(toolCallExpandedByDefault("collapsed", failed), false);
    assert.equal(toolCallExpandedByDefault("expanded", failed), true);
    assert.equal(toolCallExpandedByDefault("failed", failed), failed);
  }
});

test("ignores tool calls without an id", () => {
  clearExpandedToolCalls();
  setToolCallExpanded(undefined, true);
  assert.equal(isToolCallExpanded(undefined), undefined);
});

test("counts failed children of successful waits and mounted dispatches", () => {
  const wait = { type: "toolCall", toolCallId: "wait", toolName: "wait", input: {} };
  const bash = { type: "toolCall", toolCallId: "bash", toolName: "bash", input: {} };
  const patch = { type: "toolCall", toolCallId: "patch", toolName: "apply_patch", input: {} };
  const jobs = [{ id: "bad", type: "task", status: "failed" }, { id: "good", type: "task", status: "completed" }];
  const results = new Map([
    ["wait", { role: "toolResult", toolCallId: "wait", content: [], details: { op: "wait", jobs } }],
    ["bash", { role: "toolResult", toolCallId: "bash", content: [], details: {
      toolCommands: [{ tool: "wait", mode: "execute", exitCode: 0, inner: { op: "wait", jobs } }],
    } }],
    ["patch", { role: "toolResult", toolCallId: "patch", content: [], details: { result: { failures: [{ message: "failed" }] } } }],
  ]);
  assert.equal(countToolCallFailures([wait, bash, patch], results), 3);
  assert.equal(countToolCallFailures([wait], undefined), 0);
});
