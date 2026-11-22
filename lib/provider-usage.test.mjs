import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { summarizeProviderUsage } = await jiti.import("./provider-usage.ts");

const NOW = Date.parse("2026-11-22T03:00:00Z");
const HOUR = 3_600_000;

function limit(id, windowId, usedFraction, scope = {}, window = {}) {
  return {
    id,
    label: id,
    scope: { provider: scope.provider ?? "anthropic", windowId, ...scope },
    window: { id: windowId, resetsAt: NOW + HOUR, ...window },
    amount: { usedFraction, unit: "percent" },
  };
}

function report(provider, limits, extra = {}) {
  return { provider, fetchedAt: NOW, limits, ...extra };
}

test("reports only the current provider's 5h and 7d windows", () => {
  const usage = summarizeProviderUsage([
    report("openai-codex", [limit("codex:5h", "5h", 0.9, { provider: "openai-codex" })]),
    report("anthropic", [limit("a:5h", "5h", 0.36), limit("a:7d", "7d", 0.19), limit("a:monthly", "monthly", 0.5)]),
  ], { provider: "anthropic", modelId: "claude-opus-5-5" }, NOW);
  assert.deepEqual(usage.fiveHour, { id: "5h", usedFraction: 0.36, resetsAt: NOW + HOUR });
  assert.equal(usage.sevenDay.usedFraction, 0.19);
  assert.equal(summarizeProviderUsage([report("anthropic", [])], { provider: "openai" }, NOW), null);
});

test("classifies windows by duration when the provider names them differently", () => {
  const usage = summarizeProviderUsage([report("openai-codex", [
    limit("codex:primary", "primary", 0.1, { provider: "openai-codex", windowId: undefined }, { id: "primary", durationMs: 5 * HOUR }),
    limit("codex:secondary", "secondary", 0.2, { provider: "openai-codex", windowId: undefined }, { id: "secondary", durationMs: 7 * 24 * HOUR }),
  ])], { provider: "openai-codex" }, NOW);
  assert.equal(usage.fiveHour.usedFraction, 0.1);
  assert.equal(usage.sevenDay.usedFraction, 0.2);
});

test("a limit scoped to the active model wins over the provider-wide one; other models' limits never apply", () => {
  const reports = [report("anthropic", [
    limit("wide:5h", "5h", 0.3),
    limit("fable:5h", "5h", 0.8, { modelId: "claude-fable-5-2" }),
  ])];
  assert.equal(summarizeProviderUsage(reports, { provider: "anthropic", modelId: "Claude-Fable-5-2" }, NOW).fiveHour.usedFraction, 0.8);
  assert.equal(summarizeProviderUsage(reports, { provider: "anthropic", modelId: "claude-opus-5-5" }, NOW).fiveHour.usedFraction, 0.3);
});

test("with an active account, other accounts' limits and resets are left out", () => {
  const credits = (count) => ({ availableCount: count, credits: [] });
  const reports = [
    report("anthropic", [limit("other:5h", "5h", 0.9)], { metadata: { email: "other@example.com" }, resetCredits: credits(3) }),
    report("anthropic", [limit("mine:5h", "5h", 0.2)], { metadata: { email: "me@example.com" }, resetCredits: credits(1) }),
  ];
  const usage = summarizeProviderUsage(reports, { provider: "anthropic", identity: { email: "ME@example.com" } }, NOW);
  assert.equal(usage.fiveHour.usedFraction, 0.2);
  assert.equal(usage.resets.bankedCount, 1);
});

test("saved resets carry counts and their banked expiries, soonest first", () => {
  const usage = summarizeProviderUsage([report("openai-codex", [], {
    resetCredits: {
      availableCount: 3,
      redeemableCount: 2,
      credits: [
        { expiresAt: "2026-12-01T22:08:21Z", status: "available" },
        { expiresAt: "2026-11-30T19:24:52Z", status: "available" },
        { expiresAt: "2026-11-29T00:00:00Z", status: "redeemed" },
      ],
    },
  })], { provider: "openai-codex" }, NOW);
  assert.equal(usage.fiveHour, undefined);
  assert.deepEqual(usage.resets, {
    bankedCount: 3,
    redeemableCount: 2,
    unavailableReason: undefined,
    expiries: [Date.parse("2026-11-30T19:24:52Z"), Date.parse("2026-12-01T22:08:21Z")],
  });
});

test("no windows and no banked resets means no usage to show", () => {
  assert.equal(summarizeProviderUsage([report("anthropic", [limit("a:monthly", "monthly", 0.5)], {
    resetCredits: { availableCount: 0 },
  })], { provider: "anthropic" }, NOW), null);
});
