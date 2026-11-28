"use client";

import { memo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatNoticeTokens, type CacheMissSummary, type TranscriptNotice } from "@/lib/transcript-notices";

// The amber Process details uses for what went wrong inside a folded turn.
export const TRANSCRIPT_NOTICE_WARNING_COLOR = "#d97706";

// A notice line is drawn as omp's TUI draws its cache-miss marker: muted text after a short dim rule.

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function transcriptNoticeText(t: Translate, notice: TranscriptNotice): string {
  switch (notice.kind) {
    case "cache_miss":
      return t("transcriptNotice.cacheMiss", { tokens: formatNoticeTokens(notice.reprocessedTokens) });
    case "model_usage":
      return t("transcriptNotice.modelUsage", { purpose: notice.purpose, model: notice.model, tokens: formatNoticeTokens(notice.totalTokens) });
    case "model_change":
      return t("transcriptNotice.modelChange", { role: notice.role, model: notice.model });
    case "thinking_level_change":
      return t("transcriptNotice.thinkingLevelChange", { level: notice.level });
    case "service_tier_change": {
      const tiers = Object.entries(notice.serviceTier).map(([family, tier]) => `${family}: ${tier}`).join(", ");
      return tiers ? t("transcriptNotice.serviceTierChange", { tier: tiers }) : t("transcriptNotice.serviceTierCleared");
    }
  }
}

/** The folded Process details header's part for the cache misses inside it. */
export function cacheMissSummaryText(t: Translate, summary: CacheMissSummary): string {
  const params = { count: summary.count, tokens: formatNoticeTokens(summary.reprocessedTokens) };
  return t(summary.count === 1 ? "transcriptNotice.foldCacheMiss" : "transcriptNotice.foldCacheMisses", params);
}

/** One line per notice, under the message they follow. */
export const TranscriptNoticeLines = memo(function TranscriptNoticeLines({ notices }: { notices: readonly TranscriptNotice[] }) {
  const { t } = useI18n();
  if (notices.length === 0) return null;
  return (
    <div className="transcript-notices" style={{ display: "flex", flexDirection: "column", gap: 2, margin: "-6px 0 12px" }}>
      {notices.map((notice, index) => (
        <div
          key={index}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--text-muted)",
            overflowWrap: "anywhere",
          }}
        >
          <span aria-hidden="true" style={{ flexShrink: 0, width: 40, borderTop: "1px solid var(--border)" }} />
          <span>{transcriptNoticeText(t, notice)}</span>
        </div>
      ))}
    </div>
  );
});
