import assert from "node:assert/strict";
import test from "node:test";
import { revealStreamingMessage } from "./streaming-presentation.ts";

const reply = (...content) => ({ role: "assistant", provider: "p", model: "m", timestamp: 1, content });
const text = (text) => ({ type: "text", text });
const thinking = (thinking) => ({ type: "thinking", thinking });
const tool = (rawInput) => ({ type: "toolCall", toolCallId: "call", toolName: "read", input: {}, rawInput });

test("presents a burst over several frames without losing arrivals or altering the source", () => {
  const first = reply(text("abcdefghijkl"));
  const frame = revealStreamingMessage(reply(), first, 1 / 3);
  assert.equal(frame.content[0].text, "abcd");
  const latest = reply(text("abcdefghijklmnop"));
  const nextFrame = revealStreamingMessage(frame, latest, 1 / 2);
  assert.equal(nextFrame.content[0].text, "abcdefghij");
  assert.equal(revealStreamingMessage(nextFrame, latest, 1).content[0].text, "abcdefghijklmnop");
  assert.equal(first.content[0].text, "abcdefghijkl");
});

test("leaves earlier blocks complete before revealing the next and never splits an emoji", () => {
  const result = revealStreamingMessage(reply(thinking("early")), reply(thinking("early and done"), text("😀ab")), 1 / 4);
  assert.deepEqual(result.content, [thinking("early and done"), text("😀")]);
});

test("paces streamed tool arguments but publishes finalized input immediately", () => {
  const frame = revealStreamingMessage(reply(tool("")), reply(tool('{"path":"a"}')), 1 / 2);
  assert.deepEqual(frame.content, [tool('{"path')]);
  const final = { ...tool(undefined), input: { path: "a" } };
  assert.deepEqual(revealStreamingMessage(frame, reply(final), 1 / 2).content, [final]);
});

test("does not replay existing text on reconnect or show a stale prefix after replacement or completion", () => {
  const before = reply(text("old answer"));
  const correction = reply(text("corrected answer"));
  const nextReply = { ...reply(text("old answer but unrelated")), timestamp: 2 };
  assert.equal(revealStreamingMessage(null, before, 1 / 3), before);
  assert.equal(revealStreamingMessage(before, correction, 1 / 3), correction);
  assert.equal(revealStreamingMessage(before, nextReply, 1 / 3), nextReply);
  assert.equal(revealStreamingMessage(before, null, 1 / 3), null);
});
