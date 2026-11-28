import { useId, useLayoutEffect, useState, type ReactNode } from "react";
import type { TokenDisplayMode } from "@/hooks/useTokenDisplay";
import { useExpansionPreference } from "@/lib/expansion-preference";
import type { CacheMissSummary } from "@/lib/transcript-notices";
import { formatTurnDuration } from "@/lib/turn-duration";
import type { AgentUsage } from "@/lib/types";
import { FoldTokenTotals, TokenFlowFold, TokenFlowHandoff } from "./TokenFlow";
import { cacheMissSummaryText, TRANSCRIPT_NOTICE_WARNING_COLOR } from "./TranscriptNotices";
import { useTranscriptFold } from "./TranscriptGrowth";

export function ProcessDetailsGroup({ messageCount, requestCount = 0, toolCallCount, failureCount, compaction = false, status, durationMs, cacheMisses, tokenDisplay = "text", usage, missingUsage = false, models = [], defaultExpanded = false, reveal = false, renderDetails, t }: {
  messageCount: number;
  requestCount?: number;
  toolCallCount: number;
  failureCount: number;
  compaction?: boolean;
  status?: string;
  durationMs?: number;
  cacheMisses?: CacheMissSummary;
  tokenDisplay?: TokenDisplayMode;
  usage?: Pick<AgentUsage, "input" | "output" | "cacheRead" | "cacheWrite">;
  missingUsage?: boolean;
  defaultExpanded?: boolean;
  models?: { provider: string; model: string }[];
  reveal?: boolean;
  renderDetails: () => ReactNode;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const preference = useExpansionPreference("process");
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? (preference === "automatic" ? defaultExpanded : preference === "expanded");
  useLayoutEffect(() => {
    if (reveal) setManualExpanded(true);
  }, [reveal]);
  const collapsed = !expanded && !reveal;
  const { detailsRef, showDetails, bracketRef, bracketsMoving, measureBrackets } = useTranscriptFold(collapsed, reveal, tokenDisplay === "flow");
  const details = showDetails ? (
    <div ref={detailsRef} data-fold-details="" inert={collapsed} style={tokenDisplay === "flow" ? undefined : { marginTop: 8 }}>
      <div className="flow-root">{renderDetails()}</div>
    </div>
  ) : null;
  const sizeParts: string[] = [];
  if (messageCount > 0) sizeParts.push(`${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`);
  if (requestCount > 0) sizeParts.push(`${requestCount} ${t(requestCount === 1 ? "chat.modelRequest" : "chat.modelRequests")}`);
  const toolParts: string[] = [];
  if (toolCallCount > 0) toolParts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);
  const otherParts: string[] = [];
  if (compaction) otherParts.push(t("i18n.conversationCompacted"));
  if (status && collapsed) otherParts.push(status);
  if (durationMs !== undefined) otherParts.push(t("chat.turnDuration", { time: formatTurnDuration(durationMs) }));
  const parts = [...sizeParts, ...toolParts, ...otherParts];
  // Folded, the cache misses inside are added up here; open, each shows under its step.
  const cacheMissText = cacheMisses && !(expanded || reveal) ? cacheMissSummaryText(t, cacheMisses) : undefined;
  const failureText = failureCount > 0 && !(expanded || reveal) ? t("chat.processFailures", { count: failureCount }) : undefined;

  const expandedNow = expanded || reveal;
  const toggleIcon = (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 6h7" />
      {!expandedNow && <path d="M6 2.5v7" />}
    </svg>
  );
  const summary = (
    <>
      {parts.join(" · ")}
      {failureText && <span style={{ color: TRANSCRIPT_NOTICE_WARNING_COLOR }}>{` · ${failureText}`}</span>}
      {cacheMissText && ` · ${cacheMissText}`}
    </>
  );
  const foldSummaryId = useId();
  const toggleProps = {
    type: "button" as const,
    "aria-expanded": !collapsed,
    onClick: () => setManualExpanded(collapsed),
    title: collapsed ? t("chat.expandProcess") : t("chat.collapseProcess"),
  };
  const toggle = (
    <button
      {...toggleProps}
      className="transcript-fold-toggle"
      aria-label={t("chat.processDetails")}
      aria-describedby={foldSummaryId}
    >
      <span style={{ flexShrink: 0, display: "inline-flex" }} aria-hidden="true">{toggleIcon}</span>
      <span className="transcript-fold-label" id={foldSummaryId} dir="auto">
        <span>{summary}</span>
        {collapsed && tokenDisplay === "text" && requestCount > 0 && <FoldTokenTotals usage={usage} missing={missingUsage} />}
      </span>
    </button>
  );
  // In flow mode a run of requests is drawn on the wire: collapsed as a bracketed turn marker whose rows hold the
  // fold's stats, open as a handoff row. Either way the toggle is an icon button on the wire.
  let body: ReactNode;
  if (tokenDisplay === "flow") {
    const summaryLabel = [t("chat.processDetails"), ...parts, failureText, cacheMissText].filter(Boolean).join(" · ");
    const iconToggle = (
      <button {...toggleProps} className="token-flow-handoff-icon token-flow-fold-toggle" aria-label={summaryLabel}>{toggleIcon}</button>
    );
    const foldProps = {
      usage, missing: missingUsage, models, hasRequests: requestCount > 0,
      outputRows: [...sizeParts, ...otherParts],
      inputRows: [...toolParts, failureText && <span style={{ color: TRANSCRIPT_NOTICE_WARNING_COLOR }}>{failureText}</span>, cacheMissText].filter(Boolean),
    };
    body = (
      <div className="transcript-process transcript-flow-fold-group" data-fold-moving={bracketsMoving ? "" : undefined}>
        <div ref={bracketRef} className="transcript-fold-brackets" aria-hidden="true" />
        {showDetails ? (
          <>
            {measureBrackets && <div className="transcript-fold-measure" aria-hidden="true"><TokenFlowFold {...foldProps} measure /></div>}
            <TokenFlowHandoff kind="process" label={summaryLabel} time={null}>{iconToggle}</TokenFlowHandoff>
            {details}
            <TokenFlowHandoff kind="process-end" label={summaryLabel} time={null}>{iconToggle}</TokenFlowHandoff>
          </>
        ) : <TokenFlowFold {...foldProps} bottomToggle={iconToggle}>{iconToggle}</TokenFlowFold>}
      </div>
    );
  } else {
    body = (
      <div className="transcript-process">
        {toggle}
        {details}
        {showDetails && <button {...toggleProps} className="transcript-fold-toggle" aria-label={toggleProps.title}>{toggleIcon}</button>}
      </div>
    );
  }
  return body;
}
