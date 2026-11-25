import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { assertPromptCacheLossConfirmed, PromptCacheLossError } = await jiti.import("./prompt-cache.ts");
const { sendConfirmingCacheLoss, sendAgentCommand } = await jiti.import("./agent-client.ts");
const { PROMPT_CACHE_WARM_CODE } = await jiti.import("./prompt-cache-shared.ts");

const TTL_MS = 300_000;
const modelChange = { kind: "model", from: "Claude A", to: "Claude B" };

/** A session whose warmer last touched its cache `ageMs` ago. */
function sessionTouched(ageMs) {
  return {
    getPromptCacheStatus: (nowMs = Date.now()) => ({ state: "warm", inferred: false, tier: "short", touchedAt: nowMs - ageMs, ttlMs: TTL_MS }),
  };
}

test("a change to a warm cache is held back until the request confirms the loss", () => {
  const session = sessionTouched(60_000);
  assert.throws(
    () => assertPromptCacheLossConfirmed(session, modelChange, false),
    (error) => {
      assert.ok(error instanceof PromptCacheLossError);
      assert.deepEqual(error.warning.change, modelChange);
      assert.ok(error.warning.expiresAt > Date.now());
      return true;
    },
  );
  assert.doesNotThrow(() => assertPromptCacheLossConfirmed(session, modelChange, true));
});

test("a lapsed cache, no cache and no change go ahead without asking", () => {
  assert.doesNotThrow(() => assertPromptCacheLossConfirmed(sessionTouched(TTL_MS + 1), modelChange, false));
  assert.doesNotThrow(() => assertPromptCacheLossConfirmed({}, modelChange, false));
  assert.doesNotThrow(() => assertPromptCacheLossConfirmed(sessionTouched(0), undefined, false));
});

test("a held-back command is sent again confirmed only when the user agrees", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const warning = { change: modelChange, expiresAt: Date.now() + TTL_MS };
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return body.confirmCacheLoss
      ? Response.json({ success: true, data: null })
      : Response.json({ error: "held back", code: PROMPT_CACHE_WARM_CODE, accepted: false, cacheLoss: warning }, { status: 409 });
  };
  const send = (confirmCacheLoss) => sendAgentCommand("s1", confirmCacheLoss ? { type: "set_model", confirmCacheLoss } : { type: "set_model" });

  const asked = [];
  assert.equal(await sendConfirmingCacheLoss(send, async (question) => { asked.push(question); return false; }), false);
  assert.deepEqual(asked, [warning]);
  assert.equal(bodies.length, 1);

  assert.equal(await sendConfirmingCacheLoss(send, async () => true), true);
  assert.deepEqual(bodies.slice(1).map((body) => body.confirmCacheLoss === true), [false, true]);
});
