"use client";

import type { ProviderUsageSummary, ProviderUsageWindow } from "@/lib/provider-usage-types";
import { formatResetCountdown, usageLevelColor } from "@/lib/session-stats-format";

type Translate = (key: string, params?: Record<string, string | number>) => string;

function windowsOf(usage: ProviderUsageSummary): ProviderUsageWindow[] {
  return [usage.fiveHour, usage.sevenDay].filter((window): window is ProviderUsageWindow => window !== undefined);
}

function percentOf(window: ProviderUsageWindow): number {
  return Math.round(window.usedFraction * 100);
}

/** The stats bar's compact readout: `5h 36% 4h · 7d 19% 5d ↺1`. */
export function ProviderUsageCompact({ usage, mobile, now }: { usage: ProviderUsageSummary; mobile: boolean; now: number }) {
  const resets = usage.resets;
  return (
    <>
      {windowsOf(usage).map((window) => (
        <span key={window.id} style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, color: usageLevelColor(percentOf(window)) }}>
          <span style={{ color: "var(--text-dim)" }}>{window.id}</span>
          {`${percentOf(window)}%`}
          {!mobile && window.resetsAt !== undefined && (
            <span style={{ color: "var(--text-dim)" }}>{formatResetCountdown(window.resetsAt - now, true)}</span>
          )}
        </span>
      ))}
      {resets && (
        <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>{`↺${resets.bankedCount}`}</span>
      )}
    </>
  );
}

/** One line per window for the stats button's tooltip. */
export function providerUsageTooltipParts(usage: ProviderUsageSummary, t: Translate, now: number): string[] {
  const parts = windowsOf(usage).map((window) => window.resetsAt === undefined
    ? `${window.id}: ${percentOf(window)}%`
    : `${window.id}: ${percentOf(window)}% (${t("providerUsage.resetsIn", { time: formatResetCountdown(window.resetsAt - now) })})`);
  if (usage.resets) parts.push(`${t("providerUsage.freeResets")}: ${usage.resets.bankedCount}`);
  return parts;
}

/** Rows for the Tokens section of the session popover. */
export function providerUsageRows(usage: ProviderUsageSummary, t: Translate, locale: string, now: number): string[][] {
  const rows = windowsOf(usage).map((window) => [
    window.id,
    window.resetsAt === undefined
      ? `${percentOf(window)}%`
      : `${percentOf(window)}% · ${t("providerUsage.resetsIn", { time: formatResetCountdown(window.resetsAt - now) })}`,
  ]);
  const resets = usage.resets;
  if (!resets) return rows;
  rows.push([
    t("providerUsage.freeResets"),
    resets.redeemableCount === resets.bankedCount
      ? String(resets.bankedCount)
      : t("providerUsage.freeResetsUsable", { count: resets.bankedCount, usable: resets.redeemableCount }),
  ]);
  if (resets.unavailableReason) rows.push(["", resets.unavailableReason]);
  for (const expiry of resets.expiries) {
    const date = new Date(expiry).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    rows.push([t("providerUsage.resetExpires"), `${date} (${formatResetCountdown(expiry - now)})`]);
  }
  return rows;
}
