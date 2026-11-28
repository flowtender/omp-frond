import assert from "node:assert/strict";
import test from "node:test";
import { COMPACT_MODES as SDK_MODES, parseCompactArgs } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import { COMPACT_MODES, compactCommand, compactModeTakesFocus, splitCompactArgs } from "./compact-modes.ts";

test("mirrors the SDK's modes and which of them reject focus", () => {
  assert.deepEqual([...COMPACT_MODES], SDK_MODES.map((mode) => mode.name));
  for (const mode of SDK_MODES) {
    assert.equal(compactModeTakesFocus(mode.name), !mode.rejectsFocus, mode.name);
  }
});

test("splits /compact arguments the way the SDK parses them", () => {
  for (const args of ["", "  ", "focus on the parser", "soft", "SOFT focus on X", "handoff  keep the plan", "snapcompact", "remote now"]) {
    const sdk = parseCompactArgs(args);
    const request = splitCompactArgs(args);
    assert.equal(request.mode, sdk.mode, args);
    assert.equal(request.focus, sdk.instructions, args);
  }
});

test("builds the compact command from a request", () => {
  assert.deepEqual(compactCommand({}), { type: "compact" });
  assert.deepEqual(compactCommand({ mode: "handoff", focus: "keep the plan" }), {
    type: "compact",
    mode: "handoff",
    customInstructions: "keep the plan",
  });
});
