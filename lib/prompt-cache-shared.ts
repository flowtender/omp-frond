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

// A minute value that fits in a browser's signed 32-bit timeout.
export const MAX_INFERRED_CACHE_TIMEOUT_MINUTES = Math.floor(0x7fffffff / 60_000);

export interface PromptCacheIndicatorSettings {
  source: PromptCacheIndicatorSource;
  style: PromptCacheIndicatorStyle;
  /** Dim a status read off a transcript and mark it with a question mark. */
  distinguishInferred: boolean;
  /** Fallback for inferred entries without a lifetime; zero uses omp's estimate. */
  inferredTimeoutMinutes: number;
}

/** The terminal's behaviour: every session's marker, inferred or not, drawn the same way. */
export const PROMPT_CACHE_INDICATOR_DEFAULTS: PromptCacheIndicatorSettings = {
  source: "inferred",
  style: "terminal",
  distinguishInferred: false,
  inferredTimeoutMinutes: 0,
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
  const { source, style, distinguishInferred, inferredTimeoutMinutes } = parsed as Record<string, unknown>;
  return {
    source: source === "off" || source === "live" || source === "inferred" ? source : PROMPT_CACHE_INDICATOR_DEFAULTS.source,
    style: style === "terminal" || style === "gradient" ? style : PROMPT_CACHE_INDICATOR_DEFAULTS.style,
    distinguishInferred: typeof distinguishInferred === "boolean" ? distinguishInferred : PROMPT_CACHE_INDICATOR_DEFAULTS.distinguishInferred,
    inferredTimeoutMinutes: typeof inferredTimeoutMinutes === "number" && Number.isInteger(inferredTimeoutMinutes)
      && inferredTimeoutMinutes >= 0 && inferredTimeoutMinutes <= MAX_INFERRED_CACHE_TIMEOUT_MINUTES
      ? inferredTimeoutMinutes : PROMPT_CACHE_INDICATOR_DEFAULTS.inferredTimeoutMinutes,
  };
}

/** The indicator's report, with a local fallback lifetime for inferred entries. */
export function visiblePromptCacheInfo(
  { source, inferredTimeoutMinutes }: PromptCacheIndicatorSettings,
  report: PromptCacheReport | null | undefined,
): PromptCacheInfo | null {
  if (!report || source === "off" || (!report.live && source !== "inferred")) return null;
  const { info } = report;
  if (info.state === "warm" && info.inferred && info.ttlMs === undefined && inferredTimeoutMinutes > 0) {
    return { ...info, ttlMs: inferredTimeoutMinutes * 60_000 };
  }
  return info;
}

export type PromptCacheReports = Readonly<Record<string, PromptCacheReport>>;

/** `previous` when `next` reports the same, so a poll that changed nothing re-renders nothing. */
export function keepSamePromptCacheReports(previous: PromptCacheReports, next: PromptCacheReports): PromptCacheReports {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/** A change the user asked for that would make the next request miss a warm prompt cache. */
export type PromptCacheChange =
  | { kind: "model"; from: string; to: string }
  | { kind: "thinking"; from: string; to: string }
  /** A reload may replace the tools or the system prompt; whether it does is known only afterwards. */
  | { kind: "reload" };

/** Why a cache-breaking command was held back for the user's confirmation. */
export interface PromptCacheLossWarning {
  change: PromptCacheChange;
  /** When the warm entry lapses on its own; absent for one that never expires. */
  expiresAt?: number;
}

/** `code` of a command the server held back because it would break a warm cache. */
export const PROMPT_CACHE_WARM_CODE = "prompt_cache_warm";
