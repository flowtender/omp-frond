import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AgentUsage } from "@/lib/types";
import { ProviderIcon, modelIconProviders } from "./ProviderIcon";
import { CacheGlyph } from "./CacheGlyph";

type TokenTotals = Pick<AgentUsage, "input" | "output" | "cacheRead" | "cacheWrite">;

export function TokenFlow({ usage, provider, model, modelName, estimatedOutput, tokensPerSecond, time }: {
  usage?: AgentUsage;
  provider: string;
  model: string;
  modelName: string;
  estimatedOutput?: number;
  tokensPerSecond?: number | null;
  time?: string | null;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="token-flow" data-token-flow="" data-transcript-port="model" role="group" aria-label={`${t("settings.tokenDisplay")}: ${modelName}`}>
      <svg className="token-flow-wire" aria-hidden="true" width="100%" height="100%"><path /></svg>
      <InputCounts usage={usage} />
      <ModelMark icon={modelIconProviders(provider, model).at(-1)} title={modelName} />
      <OutputCounts usage={usage} estimatedOutput={estimatedOutput} />
      {tokensPerSecond != null && <span className="token-flow-rate">{tokensPerSecond.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} t/s</span>}
      <FlowTime time={time} />
    </div>
  );
}

/**
 * A collapsed run of requests: the wire drops into a bracket pair around the AI icon.
 * New input and cache writes sit above the icon and output below it; stat rows flank it,
 * outputs-side rows left and input-side rows right. The toggle (children) sits on the wire entering the bracket.
 */
export function TokenFlowFold({ usage, missing, models, hasRequests, outputRows, inputRows, children }: {
  usage?: TokenTotals;
  missing: boolean;
  models: { provider: string; model: string }[];
  /** A gap can hold only the steps after a request that already showed its own row; it has no totals. */
  hasRequests: boolean;
  outputRows: ReactNode[];
  inputRows: ReactNode[];
  children: ReactNode;
}) {
  const { t } = useI18n();
  // A fold spanning several models has no single icon to show.
  const icons = new Set(models.map(({ provider, model }) => modelIconProviders(provider, model).at(-1)));
  const statRows = (rows: ReactNode[]) => rows.map((row, index) => <span key={index} className="token-flow-fold-stat">{row}</span>);
  return (
    <div className="token-flow token-flow-fold" data-transcript-port="fold" role="group" aria-label={t("chat.processDetails")}>
      <svg className="token-flow-wire" aria-hidden="true" width="100%" height="100%"><path /></svg>
      <div className="token-flow-fold-toggle-slot">{children}</div>
      <div className="token-flow-fold-body">
        <div className="token-flow-fold-side token-flow-fold-output">{statRows(outputRows)}</div>
        <div className="token-flow-fold-center">
          {hasRequests && <InputCounts usage={usage} partial={missing} />}
          <ModelMark icon={icons.size === 1 ? [...icons][0] : undefined} />
          {hasRequests && <OutputCounts usage={usage} partial={missing} />}
        </div>
        <div className="token-flow-fold-side token-flow-fold-input">{statRows(inputRows)}</div>
      </div>
    </div>
  );
}

export function TokenFlowHandoff({ kind, label, time, children }: {
  kind: "tools" | "user" | "compaction" | "process";
  label: string;
  time: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="token-flow token-flow-handoff" data-token-handoff={kind} data-transcript-port={kind === "process" ? "process" : "handoff"} role="group" aria-label={label}>
      <svg className="token-flow-wire" aria-hidden="true" width="100%" height="100%"><path /></svg>
      <div className="token-flow-handoff-icons">{children ?? (
        <span className="token-flow-handoff-icon" title={label} aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {kind === "user" ? <><circle cx="12" cy="8" r="3.5" /><path d="M5 20v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2" /></> : (
              <path d="m7.5 8 2.7-4.5a2 2 0 0 1 3.5 0L17 9m-4-1 4 1 1-4m.5 6.5 2.6 4.5a2 2 0 0 1-1.7 3H14m2.8-3L14 19l2.8 3m-6.3-3H5a2 2 0 0 1-1.7-3L6 11m1 4-1-4-4 1" />
            )}
          </svg>
        </span>
      )}</div>
      <FlowTime time={time} />
    </div>
  );
}

export function FoldTokenTotals({ usage, missing }: {
  usage?: TokenTotals;
  missing: boolean;
}) {
  const { t, locale } = useI18n();
  return (
    <span className="transcript-fold-totals">
      <FlowCount label={t("chat.newInputTokens")} shortLabel={t("chat.tokenFlowIn")} count={usage?.input} locale={locale} partial={missing} />
      <FlowCount label={t("session.output")} shortLabel={t("chat.tokenFlowOut")} count={usage?.output} locale={locale} partial={missing} />
      <FlowCount label={t("session.cacheRead")} cache="R" count={usage?.cacheRead} locale={locale} partial={missing} />
      <FlowCount label={t("session.cacheWrite")} cache="W" count={usage?.cacheWrite} locale={locale} partial={missing} />
    </span>
  );
}

/** Tokens going into the model: cache writes plus new input above the wire, cache reads below it. */
function InputCounts({ usage, partial }: { usage?: TokenTotals; partial?: boolean }) {
  const { t, locale } = useI18n();
  return (
    <div className="token-flow-counts">
      <span className="token-flow-sum">
        <FlowCount label={t("chat.newInputTokens")} shortLabel={t("chat.tokenFlowIn")} count={usage?.input} locale={locale} partial={partial} />
        {Boolean(usage?.cacheWrite) && <span aria-hidden="true">+</span>}
        <FlowCount label={t("session.cacheWrite")} cache="W" count={usage?.cacheWrite} locale={locale} partial={partial} />
      </span>
      <FlowCount row={2} label={t("session.cacheRead")} cache="R" count={usage?.cacheRead} locale={locale} partial={partial} />
    </div>
  );
}

/** Tokens coming out of the model: output below the wire. */
function OutputCounts({ usage, estimatedOutput, partial }: { usage?: TokenTotals; estimatedOutput?: number; partial?: boolean }) {
  const { t, locale } = useI18n();
  return (
    <div className="token-flow-counts">
      <FlowCount row={2} label={t("session.output")} shortLabel={t("chat.tokenFlowOut")} count={usage?.output ?? estimatedOutput} estimated={estimatedOutput !== undefined} locale={locale} partial={partial} />
    </div>
  );
}

function ModelMark({ icon, title }: { icon?: string; title?: string }) {
  return (
    <span className="token-flow-model" title={title} aria-hidden="true">
      {icon ? <ProviderIcon id={icon} size={24} /> : (
        <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
          <path d="M8 1.5 14 5v6l-6 3.5L2 11V5zM2 5l6 3.5L14 5M8 8.5v6" />
        </svg>
      )}
    </span>
  );
}

function FlowTime({ time }: { time?: string | null }) {
  return time ? <span className="token-flow-time">{time}</span> : null;
}

function FlowCount({ row, label, shortLabel, cache, count, estimated, locale, partial }: {
  /** Grid row above (1) or below (2) the wire; a hidden neighbour must not move this count. */
  row?: 1 | 2;
  label: string;
  shortLabel?: string;
  cache?: "R" | "W";
  count?: number;
  estimated?: boolean;
  locale: string;
  partial?: boolean;
}) {
  const { t } = useI18n();
  if (cache && !count) return null;
  const formatted = count?.toLocaleString(locale) ?? "—";
  const title = `${label}: ${count === undefined ? t("chat.tokenCountNotReported") : formatted}`;
  const incomplete = partial && count !== undefined;
  const description = incomplete ? t("chat.foldPartialUsage") : estimated ? t("i18n.estimatedTokens") : undefined;
  return (
    <span className="token-flow-count" style={row ? { gridRow: row } : undefined} title={description ? `${title} · ${description}` : title}>
      <span className="sr-only">{label}: </span>
      <span className="token-flow-label" aria-hidden="true">{cache ? <><CacheGlyph size={11} />{cache}</> : shortLabel}</span>
      <b>{incomplete ? "≥" : estimated && "≈"}{formatted}</b>
    </span>
  );
}
