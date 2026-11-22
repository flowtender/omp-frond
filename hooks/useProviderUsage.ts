"use client";

import { useEffect, useState } from "react";
import type { ProviderUsageSummary } from "@/lib/provider-usage-types";

// The server answers from omp's five-minute report cache, so a minute keeps
// the countdowns fresh without reaching the provider more often than omp does.
const POLL_INTERVAL_MS = 60_000;

/** Subscription usage for the account behind `model`, or null when it has none. */
export function useProviderUsage(
  model: { provider: string; modelId: string } | null,
  sessionId: string | undefined,
): ProviderUsageSummary | null {
  const [usage, setUsage] = useState<ProviderUsageSummary | null>(null);
  const provider = model?.provider;
  const modelId = model?.modelId;

  useEffect(() => {
    setUsage(null);
    if (!provider) return;
    const query = new URLSearchParams({ provider });
    if (modelId) query.set("model", modelId);
    if (sessionId) query.set("session", sessionId);
    let controller: AbortController | null = null;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(`/api/provider-usage?${query}`, { signal: controller.signal });
        if (!res.ok) return;
        const body = await res.json() as { usage: ProviderUsageSummary | null };
        setUsage(body.usage);
      } catch {
        // Usage is advisory: keep the last report until the next poll.
      }
    };
    void load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
      controller?.abort();
    };
  }, [provider, modelId, sessionId]);

  return usage;
}
