import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AgentUsage } from "@/lib/types";
import { ProviderIcon, modelIconProviders } from "./ProviderIcon";
import { CacheGlyph } from "./CacheGlyph";

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
  const icon = modelIconProviders(provider, model).at(-1);
  return (
    <div className="token-flow" data-token-flow="" role="group" aria-label={`${t("settings.tokenDisplay")}: ${modelName}`}>
      <svg className="token-flow-wire" aria-hidden="true" width="100%" height="100%"><path /></svg>
      <div className="token-flow-counts">
        <FlowCount label={t("chat.newInputTokens")} shortLabel={t("chat.tokenFlowIn")} count={usage?.input} locale={locale} />
        <FlowCount label={t("session.cacheRead")} cache="R" count={usage?.cacheRead} locale={locale} />
      </div>
      <span className="token-flow-model" title={modelName} aria-hidden="true">
        {icon ? <ProviderIcon id={icon} size={24} /> : (
          <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
            <path d="M8 1.5 14 5v6l-6 3.5L2 11V5zM2 5l6 3.5L14 5M8 8.5v6" />
          </svg>
        )}
      </span>
      <div className="token-flow-counts">
        <FlowCount label={t("session.cacheWrite")} cache="W" count={usage?.cacheWrite} locale={locale} />
        <FlowCount label={t("session.output")} shortLabel={t("chat.tokenFlowOut")} count={usage?.output ?? estimatedOutput} estimated={estimatedOutput !== undefined} locale={locale} />
      </div>
      {tokensPerSecond != null && <span className="token-flow-rate">{tokensPerSecond.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} t/s</span>}
      <FlowTime time={time} />
    </div>
  );
}

export function TokenFlowHandoff({ kind, label, display, time, children, button }: {
  kind: "tools" | "user" | "compaction" | "process";
  label: string;
  display?: ReactNode;
  time: string | null;
  children?: ReactNode;
  button?: { expanded: boolean; onClick: () => void };
}) {
  const content = (
    <>
      <svg className="token-flow-wire" aria-hidden="true" width="100%" height="100%"><path /></svg>
      <div className="token-flow-handoff-icons">{children ?? (
        <span className="token-flow-handoff-icon" title={label} aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {kind === "user" ? <><circle cx="12" cy="8" r="3.5" /><path d="M5 20v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2" /></> : (
              <path d="m7.5 8 2.7-4.5a2 2 0 0 1 3.5 0L17 9m-4-1 4 1 1-4m.5 6.5 2.6 4.5a2 2 0 0 1-1.7 3H14m2.8-3L14 19l2.8 3m-6.3-3H5a2 2 0 0 1-1.7-3L6 11m1 4-1-4-4 1" />
            )}
          </svg>
        </span>
      )}{display !== undefined && <span className="token-flow-handoff-label">{display}</span>}</div>
      <FlowTime time={time} />
    </>
  );
  if (button) return (
    <button type="button" className="token-flow token-flow-handoff token-flow-handoff-fold" data-token-handoff={kind} aria-expanded={button.expanded} aria-label={label} onClick={button.onClick}>
      {content}
    </button>
  );
  return (
    <div className="token-flow token-flow-handoff" data-token-handoff={kind} role="group" aria-label={label}>
      {content}
    </div>
  );
}

function FlowTime({ time }: { time?: string | null }) {
  return time ? <span className="token-flow-time">{time}</span> : null;
}

function FlowCount({ label, shortLabel, cache, count, estimated, locale }: {
  label: string;
  shortLabel?: string;
  cache?: "R" | "W";
  count?: number;
  estimated?: boolean;
  locale: string;
}) {
  const { t } = useI18n();
  const formatted = count?.toLocaleString(locale) ?? "—";
  const title = `${label}: ${count === undefined ? t("chat.tokenCountNotReported") : formatted}`;
  const description = estimated ? t("i18n.estimatedTokens") : cache === "W" && count === 0 ? t("chat.cacheWriteZero") : undefined;
  return (
    <span className="token-flow-count" title={description ? `${title} · ${description}` : title}>
      <span className="sr-only">{label}: </span>
      <span className="token-flow-label" aria-hidden="true">{cache ? <><CacheGlyph size={11} />{cache}</> : shortLabel}</span>
      <b>{estimated && "≈"}{formatted}</b>
    </span>
  );
}
