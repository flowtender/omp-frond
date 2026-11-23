import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { runHintAction } = await jiti.import("./session-run-hint.ts");

const idle = { attached: false, localRunning: false, promptPending: false };
const running = (sessionId, activity = "a") => ({ sessionId, running: true, activity });
const stopped = (sessionId, activity = "a") => ({ sessionId, running: false, activity });

test("an idle view that sees a run start elsewhere reloads history, then follows it", () => {
  assert.equal(runHintAction(stopped("s1"), running("s1"), idle), "reload-and-follow");
});

test("the first observation is the mount's: its load already handles a run in progress", () => {
  assert.equal(runHintAction(null, running("s1"), idle), "none");
  assert.equal(runHintAction(null, stopped("s1"), idle), "none");
});

test("switching to another session that is already running follows it without a reload", () => {
  assert.equal(runHintAction(stopped("s2"), running("s1"), idle), "follow");
});

test("a run still reported as running after a failed connect is followed again", () => {
  assert.equal(runHintAction(running("s1"), running("s1"), idle), "follow");
});

test("a run this device is already attached to, or sent, is left to its own stream", () => {
  assert.equal(runHintAction(stopped("s1"), running("s1"), { ...idle, attached: true }), "none");
  assert.equal(runHintAction(stopped("s1"), running("s1"), { ...idle, localRunning: true }), "none");
  assert.equal(runHintAction(stopped("s1"), running("s1"), { ...idle, promptPending: true }), "none");
});

test("a run that ends while this view is not attached reloads history for the final messages", () => {
  assert.equal(runHintAction(running("s1"), stopped("s1"), idle), "reload");
});

test("a run that ends while this view is attached is left to the stream that delivered it", () => {
  assert.equal(runHintAction(running("s1"), stopped("s1"), { ...idle, attached: true }), "none");
  assert.equal(runHintAction(running("s1"), stopped("s1"), { ...idle, localRunning: true }), "none");
});

test("a fast run that starts and ends between polls reloads an idle view when the row's activity changed", () => {
  assert.equal(runHintAction(stopped("s1", "a"), stopped("s1", "b"), idle), "reload");
});

test("an activity change on an attached or busy view is left to its own stream", () => {
  assert.equal(runHintAction(stopped("s1", "a"), stopped("s1", "b"), { ...idle, attached: true }), "none");
  assert.equal(runHintAction(stopped("s1", "a"), stopped("s1", "b"), { ...idle, localRunning: true }), "none");
  assert.equal(runHintAction(stopped("s1", "a"), stopped("s1", "b"), { ...idle, promptPending: true }), "none");
});

test("a row whose details are hydrating carries no activity, so hydration alone does not reload", () => {
  assert.equal(runHintAction(stopped("s1", null), stopped("s1", "a"), idle), "none");
  assert.equal(runHintAction(stopped("s1", "a"), stopped("s1", null), idle), "none");
});

test("an activity change while a run is in progress reloads, then follows", () => {
  assert.equal(runHintAction(running("s1", "a"), running("s1", "b"), idle), "reload-and-follow");
  assert.equal(runHintAction(running("s1", "a"), running("s1", "a"), idle), "follow");
});

test("an idle session stays idle, and a session switch that was never running does nothing", () => {
  assert.equal(runHintAction(stopped("s1"), stopped("s1"), idle), "none");
  assert.equal(runHintAction(running("s2"), stopped("s1"), idle), "none");
});
