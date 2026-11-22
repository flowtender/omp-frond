import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatActiveDuration, formatCompactCount, formatCostShort, formatResetCountdown } = await jiti.import("./session-stats-format.ts");

test("formats counts, costs and durations as the stats toolbar shows them", () => {
  assert.equal(formatCompactCount(950), "950");
  assert.equal(formatCompactCount(18_400), "18k");
  assert.equal(formatCompactCount(1_240_000), "1.2M");
  assert.equal(formatCostShort(0), null);
  assert.equal(formatCostShort(0.004), "<$0.01");
  assert.equal(formatCostShort(0.456), "$0.46");
  assert.equal(formatActiveDuration(0), "0s");
  assert.equal(formatActiveDuration(42_000), "42s");
  assert.equal(formatActiveDuration(185_000), "3m 5s");
  assert.equal(formatActiveDuration(4_800_000), "1h 20m");
});

test("formats quota reset countdowns in full and compact forms", () => {
  assert.equal(formatResetCountdown(-5_000), "<1m");
  assert.equal(formatResetCountdown(30_000), "1m");
  assert.equal(formatResetCountdown(45 * 60_000), "45m");
  assert.equal(formatResetCountdown(4 * 3_600_000 + 12 * 60_000), "4h 12m");
  assert.equal(formatResetCountdown(4 * 3_600_000 + 12 * 60_000, true), "4h");
  assert.equal(formatResetCountdown(5 * 86_400_000 + 20 * 3_600_000), "5d 20h");
  assert.equal(formatResetCountdown(5 * 86_400_000 + 20 * 3_600_000, true), "5d");
});
