import type { TranscriptNoticeKind } from "./transcript-notices";

// Client-safe: which session entries beside the conversation the chat draws as
// lines under a message (lib/entry-notices.ts). Per browser, all off by default.
// Cache misses are not among them: omp's own `display.cacheMissMarker` rules those.

export const SESSION_EVENT_NOTICE_KINDS = [
  "model_usage",
  "model_change",
  "thinking_level_change",
  "service_tier_change",
] as const satisfies readonly TranscriptNoticeKind[];

export type SessionEventNoticeKind = (typeof SESSION_EVENT_NOTICE_KINDS)[number];
export type SessionEventNoticeSettings = Record<SessionEventNoticeKind, boolean>;

export const SESSION_EVENT_NOTICE_DEFAULTS: SessionEventNoticeSettings = {
  model_usage: false,
  model_change: false,
  thinking_level_change: false,
  service_tier_change: false,
};

export function parseSessionEventNoticeSettings(raw: string | null): SessionEventNoticeSettings {
  if (!raw) return SESSION_EVENT_NOTICE_DEFAULTS;
  const stored: unknown = JSON.parse(raw);
  const chosen = typeof stored === "object" && stored !== null ? stored as Record<string, unknown> : {};
  return {
    model_usage: chosen.model_usage === true,
    model_change: chosen.model_change === true,
    thinking_level_change: chosen.thinking_level_change === true,
    service_tier_change: chosen.service_tier_change === true,
  };
}
