/**
 * Client-safe view of omp's prompt-cache status (the terminal's `cache` marker).
 * The server ships a `PromptCacheInfo`; the browser re-reads it against its own
 * clock, because an entry lapses without any event to announce it.
 */
import type { PromptCacheColdReason, PromptCacheStatus, PromptCacheWarming } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/host";

export type { PromptCacheColdReason, PromptCacheWarming };

/** omp's `PromptCacheStatus` without the token counts the indicator does not show. */
export type PromptCacheInfo = Omit<PromptCacheStatus, "cachedTokens" | "nextTokens">;

/** A status and where it came from: a live session's own warmer, or a saved transcript read without one. */
export interface PromptCacheReport {
  live: boolean;
  info: PromptCacheInfo;
}

export type PromptCacheView =
  | {
      state: "warm";
      inferred: boolean;
      /** Undefined when the provider never expires the entry. */
      expiresAt?: number;
      /** Share of the lifetime still left, 1 for an entry that never expires. */
      remaining: number;
    }
  | { state: "cold"; inferred: boolean; reason?: PromptCacheColdReason };

/**
 * `info` at `nowMs`: cold once its lifetime lapsed, as omp's `promptCacheStatus()`
 * decides it. A refresh in flight holds expiry off until the server reports its outcome.
 */
export function promptCacheViewAt(info: PromptCacheInfo, nowMs: number): PromptCacheView {
  if (info.state === "cold") return { state: "cold", inferred: info.inferred, reason: info.reason };
  if (info.ttlMs === undefined) return { state: "warm", inferred: info.inferred, remaining: 1 };
  const expiresAt = info.touchedAt + info.ttlMs;
  if (nowMs >= expiresAt && info.warming?.state !== "refreshing") {
    return { state: "cold", inferred: info.inferred, reason: { kind: "expired", at: expiresAt } };
  }
  const remaining = Math.min(1, Math.max(0, (expiresAt - nowMs) / info.ttlMs));
  return { state: "warm", inferred: info.inferred, expiresAt, remaining };
}

/** Indicator settings (Settings → UI settings → Appearance). */
export type PromptCacheIndicatorSource = "off" | "live" | "inferred";
export type PromptCacheIndicatorStyle = "terminal" | "gradient";

export interface PromptCacheIndicatorSettings {
  source: PromptCacheIndicatorSource;
  style: PromptCacheIndicatorStyle;
  /** Dim a status read off a transcript and mark it with a question mark. */
  distinguishInferred: boolean;
}

/** The terminal's behaviour: every session's marker, inferred or not, drawn the same way. */
export const PROMPT_CACHE_INDICATOR_DEFAULTS: PromptCacheIndicatorSettings = {
  source: "inferred",
  style: "terminal",
  distinguishInferred: false,
};

export function parsePromptCacheIndicatorSettings(raw: string | null): PromptCacheIndicatorSettings {
  if (!raw) return PROMPT_CACHE_INDICATOR_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return PROMPT_CACHE_INDICATOR_DEFAULTS;
  }
  if (!parsed || typeof parsed !== "object") return PROMPT_CACHE_INDICATOR_DEFAULTS;
  const { source, style, distinguishInferred } = parsed as Record<string, unknown>;
  return {
    source: source === "off" || source === "live" || source === "inferred" ? source : PROMPT_CACHE_INDICATOR_DEFAULTS.source,
    style: style === "terminal" || style === "gradient" ? style : PROMPT_CACHE_INDICATOR_DEFAULTS.style,
    distinguishInferred: typeof distinguishInferred === "boolean" ? distinguishInferred : PROMPT_CACHE_INDICATOR_DEFAULTS.distinguishInferred,
  };
}

/** What the indicator shows under `source`: a status read without a live session only when inference is allowed. */
export function visiblePromptCacheInfo(
  source: PromptCacheIndicatorSource,
  report: PromptCacheReport | null | undefined,
): PromptCacheInfo | null {
  if (!report || source === "off") return null;
  return report.live || source === "inferred" ? report.info : null;
}

export type PromptCacheReports = Readonly<Record<string, PromptCacheReport>>;

/** `previous` when `next` reports the same, so a poll that changed nothing re-renders nothing. */
export function keepSamePromptCacheReports(previous: PromptCacheReports, next: PromptCacheReports): PromptCacheReports {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
