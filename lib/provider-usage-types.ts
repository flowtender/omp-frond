// Client-safe shape of GET /api/provider-usage: the subscription quota of the
// account behind the current session's model, as omp's status line shows it.

export type ProviderUsageWindowId = "5h" | "7d";

export interface ProviderUsageWindow {
  id: ProviderUsageWindowId;
  /** 0..1; above 1 means overage. */
  usedFraction: number;
  /** Epoch ms the window resets, when the provider reports it. */
  resetsAt?: number;
}

export interface ProviderUsageResets {
  /** Saved resets the account holds, usable now or not. */
  bankedCount: number;
  /** The subset the provider says can be redeemed now. */
  redeemableCount: number;
  /** Why the banked resets cannot be redeemed now, when the provider says. */
  unavailableReason?: string;
  /** Expiry (epoch ms) of each banked reset that reports one, soonest first. */
  expiries: number[];
}

export interface ProviderUsageSummary {
  provider: string;
  fetchedAt: number;
  /** Plan or scoped tier label, e.g. Codex `pro`. */
  tier?: string;
  fiveHour?: ProviderUsageWindow;
  sevenDay?: ProviderUsageWindow;
  resets?: ProviderUsageResets;
}
