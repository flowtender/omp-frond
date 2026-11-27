import assert from "node:assert/strict";
import test from "node:test";
import { createAnimationQueue } from "./animation-queue.ts";

test("entrances wait across separate arrivals and advance after cancellation", async () => {
  const queue = createAnimationQueue();
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const thirdStarted = Promise.withResolvers();
  const order = [];
  queue.enqueue(() => { order.push("first"); return first.promise; });
  await Promise.resolve();
  queue.enqueue(() => { order.push("second"); return second.promise; });
  queue.enqueue(() => { order.push("third"); thirdStarted.resolve(); });
  assert.deepEqual(order, ["first"]);
  first.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["first", "second"]);
  second.reject(new Error("removed from transcript"));
  await thirdStarted.promise;
  assert.deepEqual(order, ["first", "second", "third"]);
});
