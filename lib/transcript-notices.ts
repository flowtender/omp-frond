// Client-safe: the lines the chat draws under a message. The server derives
// them from the session (lib/cache-miss-markers.ts for omp's cache-miss marker,
// lib/entry-notices.ts for the session entries beside the conversation) and
// hangs them on the message they follow; the chat draws each as one line.

export type TranscriptNotice =
  /** The turn lost a warm prompt cache: the provider reprocessed `reprocessedTokens` prompt tokens. */
  | { kind: "cache_miss"; reprocessedTokens: number }
  /** A model call outside the conversation (title generation, cache warming, ...). */
  | { kind: "model_usage"; purpose: string; model: string; totalTokens: number }
  | { kind: "model_change"; model: string; role: string }
  | { kind: "thinking_level_change"; level: string }
  /** Service tier per provider family; empty when the session went back to the default. */
  | { kind: "service_tier_change"; serviceTier: Record<string, string> };

export type TranscriptNoticeKind = TranscriptNotice["kind"];

/** Which kinds of notice the chat draws. */
export type TranscriptNoticeVisibility = Record<TranscriptNoticeKind, boolean>;

/** The property a chat message carries its notices in; never part of omp's message. */
export const TRANSCRIPT_NOTICES_KEY = "transcriptNotices";

/** The notices a chat message carries; empty for one without. */
export function getTranscriptNotices(message: unknown): TranscriptNotice[] {
  if (typeof message !== "object" || message === null) return [];
  const notices = (message as Record<string, unknown>)[TRANSCRIPT_NOTICES_KEY];
  return Array.isArray(notices) ? notices as TranscriptNotice[] : [];
}

/** The notices of `message` whose kind is switched on. */
export function visibleTranscriptNotices(message: unknown, visibility: TranscriptNoticeVisibility): TranscriptNotice[] {
  return getTranscriptNotices(message).filter((notice) => visibility[notice.kind]);
}

/** A copy of `message` carrying `notices`; the message itself when there are none. */
export function withTranscriptNotices<T extends object>(message: T, notices: readonly TranscriptNotice[] | undefined): T {
  if (!notices || notices.length === 0) return message;
  return { ...message, [TRANSCRIPT_NOTICES_KEY]: [...notices] };
}

/** omp's `formatNumber()` (pi-utils), which the TUI's marker uses: 999, 1.5K, 25K, 1.5M. */
export function formatNoticeTokens(count: number): string {
  const oneDecimal = (value: number) => {
    const text = value.toFixed(1);
    return text.endsWith(".0") ? text.slice(0, -2) : text;
  };
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${oneDecimal(count / 1_000)}K`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}K`;
  if (count < 10_000_000) return `${oneDecimal(count / 1_000_000)}M`;
  if (count < 1_000_000_000) return `${Math.round(count / 1_000_000)}M`;
  if (count < 10_000_000_000) return `${oneDecimal(count / 1_000_000_000)}B`;
  return `${Math.round(count / 1_000_000_000)}B`;
}

export interface CacheMissSummary {
  count: number;
  reprocessedTokens: number;
}

/** The cache misses of `messages` added up, for a folded Process details header; undefined when none. */
export function summarizeCacheMisses(messages: readonly unknown[]): CacheMissSummary | undefined {
  let summary: CacheMissSummary | undefined;
  for (const message of messages) {
    for (const notice of getTranscriptNotices(message)) {
      if (notice.kind !== "cache_miss") continue;
      summary ??= { count: 0, reprocessedTokens: 0 };
      summary.count += 1;
      summary.reprocessedTokens += notice.reprocessedTokens;
    }
  }
  return summary;
}
