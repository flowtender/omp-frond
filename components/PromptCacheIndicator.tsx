"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { usePromptCacheIndicatorSettings } from "@/hooks/usePromptCacheIndicator";
import { formatRelativeTime } from "@/lib/i18n/format";
import {
  promptCacheViewAt,
  visiblePromptCacheInfo,
  type PromptCacheColdReason,
  type PromptCacheIndicatorStyle,
  type PromptCacheReport,
  type PromptCacheView,
} from "@/lib/prompt-cache-shared";
import { CacheGlyph } from "./CacheGlyph";

/** Gradient steps per lifetime: often enough to read as a fade, never more than once a second. */
const GRADIENT_STEPS = 100;
const MIN_REPAINT_MS = 1_000;

/**
 * When the marker next looks different: at expiry, or at the next gradient
 * step. Undefined when nothing changes until the server reports again.
 */
function nextRepaintAt(view: PromptCacheView, ttlMs: number | undefined, style: PromptCacheIndicatorStyle, nowMs: number): number | undefined {
  if (view.state !== "warm" || view.expiresAt === undefined || ttlMs === undefined) return undefined;
  if (style === "terminal") return view.expiresAt;
  return Math.min(view.expiresAt, nowMs + Math.max(MIN_REPAINT_MS, ttlMs / GRADIENT_STEPS));
}

function markerColor(view: PromptCacheView, style: PromptCacheIndicatorStyle): string {
  if (style === "terminal") return view.state === "warm" ? "var(--text-dim)" : "var(--warning)";
  if (view.state === "cold") return "var(--danger)";
  return `color-mix(in srgb, var(--success) ${Math.round(view.remaining * 100)}%, var(--warning))`;
}

function coldReasonText(reason: PromptCacheColdReason | undefined, t: (key: string, params?: Record<string, string | number>) => string): string {
  switch (reason?.kind) {
    case "expired": return t("promptCache.reasonExpired");
    case "refresh-missed": return t("promptCache.reasonRefreshMissed");
    case "model": return t("promptCache.reasonModel", { from: reason.from, to: reason.to });
    case "thinking": return t("promptCache.reasonThinking", { from: reason.from, to: reason.to });
    case "tools": return t("promptCache.reasonTools");
    case "system-prompt": return t("promptCache.reasonSystemPrompt");
    case "retention": return t("promptCache.reasonRetention");
    case "compaction": return t("promptCache.reasonCompaction");
    default: return t("promptCache.reasonUnknown");
  }
}

/**
 * The prompt-cache marker for one session, drawn per the Appearance settings.
 * Renders nothing when the settings hide this report.
 */
export function PromptCacheIndicator({ report, size = 12, className }: { report: PromptCacheReport | null | undefined; size?: number; className?: string }) {
  const { locale, t } = useI18n();
  const settings = usePromptCacheIndicatorSettings();
  const info = visiblePromptCacheInfo(settings.source, report);
  const [now, setNow] = useState(() => Date.now());
  const view = info ? promptCacheViewAt(info, now) : null;
  const repaintAt = view && info ? nextRepaintAt(view, info.ttlMs, settings.style, now) : undefined;

  useEffect(() => {
    if (repaintAt === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, repaintAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [repaintAt]);

  // A new report is read against the current time, not the time of the last repaint.
  useEffect(() => {
    setNow(Date.now());
  }, [report]);

  if (!info || !view) return null;
  const marked = settings.distinguishInferred && view.inferred;
  const state = view.state === "warm"
    ? view.expiresAt === undefined
      ? t("promptCache.warmPersistent")
      : t("promptCache.warmUntil", { time: formatRelativeTime(new Date(view.expiresAt), locale, new Date(now)) })
    : t("promptCache.cold", { reason: coldReasonText(view.reason, t) });
  const title = view.inferred ? `${state}\n${t("promptCache.inferred")}` : state;
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "flex-start",
    flexShrink: 0,
    color: markerColor(view, settings.style),
    opacity: marked ? 0.5 : undefined,
  };

  return (
    <span role="img" aria-label={title} title={title} className={className} data-prompt-cache={view.state} style={style}>
      <CacheGlyph size={size} cold={view.state === "cold"} />
      {marked && <span aria-hidden="true" style={{ fontSize: Math.round(size * 0.75), lineHeight: 1, fontWeight: 700 }}>?</span>}
    </span>
  );
}
