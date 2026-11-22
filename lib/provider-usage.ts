import type { OAuthAccountIdentity, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { limitMatchesActiveAccount, reportMatchesActiveAccount } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/active-oauth-account";
import { bankedResetCreditExpiryMs, summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { getOmpRuntime } from "./omp-runtime";
import type { ProviderUsageResets, ProviderUsageSummary, ProviderUsageWindow, ProviderUsageWindowId } from "./provider-usage-types";

export interface ProviderUsageContext {
  provider: string;
  modelId?: string;
  /** The OAuth account the session runs on; omitted, every account's limits qualify. */
  identity?: OAuthAccountIdentity;
}

const HOUR_MS = 3_600_000;
const DURATION_SLACK_MS = 60_000;

function normalizeScopeValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function classifyWindow(limit: UsageLimit): ProviderUsageWindowId | undefined {
  const windowId = limit.scope.windowId ?? limit.window?.id;
  if (windowId === "5h" || windowId === "7d") return windowId;
  const durationMs = limit.window?.durationMs;
  if (durationMs === undefined) return undefined;
  if (Math.abs(durationMs - 5 * HOUR_MS) <= DURATION_SLACK_MS) return "5h";
  if (Math.abs(durationMs - 7 * 24 * HOUR_MS) <= DURATION_SLACK_MS) return "7d";
  return undefined;
}

interface ScopeGroup {
  priority: number;
  tier?: string;
  windows: ProviderUsageWindow[];
}

function summarizeResets(reports: UsageReport[], identity: OAuthAccountIdentity | undefined, nowMs: number): ProviderUsageResets | undefined {
  const withResets = reports.filter((report) => report.resetCredits);
  const report = withResets.length === 1
    ? withResets[0]
    : withResets.find((candidate) => reportMatchesActiveAccount(candidate, identity));
  const summary = summarizeUsageResetCredits(report?.resetCredits, nowMs);
  if (!report || !summary || summary.bankedCount === 0) return undefined;
  const expiries = (report.resetCredits?.credits ?? [])
    .map(bankedResetCreditExpiryMs)
    .filter((expiry): expiry is number => expiry !== undefined)
    .sort((a, b) => a - b);
  return {
    bankedCount: summary.bankedCount,
    redeemableCount: summary.redeemableCount,
    unavailableReason: summary.unavailableReason,
    expiries,
  };
}

/**
 * Reduce omp's usage reports to the 5h/7d windows and saved resets that apply
 * to one provider, model and account, choosing among scoped limits the way
 * omp's status line does: a limit scoped to the active model outranks a
 * provider-wide one, and within either an untiered limit outranks a tiered one.
 */
export function summarizeProviderUsage(
  reports: readonly UsageReport[],
  context: ProviderUsageContext,
  nowMs = Date.now(),
): ProviderUsageSummary | null {
  const providerReports = reports.filter((report) => report.provider === context.provider);
  if (providerReports.length === 0) return null;
  const activeModelId = normalizeScopeValue(context.modelId);
  const groups = new Map<string, ScopeGroup>();
  for (const report of providerReports) {
    for (const limit of report.limits) {
      if (context.identity && !limitMatchesActiveAccount(report, limit, context.identity)) continue;
      const usedFraction = limit.amount.usedFraction;
      if (typeof usedFraction !== "number") continue;
      const windowId = classifyWindow(limit);
      if (!windowId) continue;
      const modelId = normalizeScopeValue(limit.scope.modelId);
      if (modelId && modelId !== activeModelId) continue;
      const planType = report.metadata?.planType;
      const tier = limit.scope.tier?.trim() || (typeof planType === "string" && planType.trim() ? planType.trim() : undefined);
      const scopedTier = normalizeScopeValue(limit.scope.tier);
      const key = `${modelId ?? ""}\0${scopedTier ?? ""}`;
      const priority = modelId ? (scopedTier ? 1 : 0) : scopedTier ? 3 : 2;
      const group = groups.get(key) ?? { priority, tier, windows: [] };
      group.windows.push({ id: windowId, usedFraction, resetsAt: limit.window?.resetsAt });
      groups.set(key, group);
    }
  }
  let selected: ScopeGroup | undefined;
  for (const group of groups.values()) {
    if (!selected || group.priority < selected.priority) selected = group;
  }
  const resets = summarizeResets(providerReports, context.identity, nowMs);
  const fiveHour = selected?.windows.find((window) => window.id === "5h");
  const sevenDay = selected?.windows.find((window) => window.id === "7d");
  if (!fiveHour && !sevenDay && !resets) return null;
  return {
    provider: context.provider,
    fetchedAt: Math.max(...providerReports.map((report) => report.fetchedAt)),
    tier: selected?.tier,
    fiveHour,
    sevenDay,
    resets,
  };
}

/** Usage for the account a session's provider runs on, from omp's cached reports. */
export async function fetchProviderUsage(
  provider: string,
  modelId: string | undefined,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<ProviderUsageSummary | null> {
  const { authStorage } = await getOmpRuntime();
  const reports = await authStorage.usage.reports({ signal });
  if (!reports) return null;
  const identity = authStorage.oauth.identity(provider, sessionId);
  return summarizeProviderUsage(reports, { provider, modelId, identity });
}
