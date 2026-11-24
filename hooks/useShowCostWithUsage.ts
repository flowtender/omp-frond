import { useSyncExternalStore } from "react";

export const SHOW_COST_WITH_USAGE_STORAGE_KEY = "omp-show-cost-with-usage";

function readStored(): boolean {
  try {
    return window.localStorage.getItem(SHOW_COST_WITH_USAGE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let enabled: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (enabled === null) enabled = readStored();
  return enabled;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setShowCostWithUsage(next: boolean): void {
  enabled = next;
  try {
    window.localStorage.setItem(SHOW_COST_WITH_USAGE_STORAGE_KEY, String(next));
  } catch {}
  listeners.forEach((listener) => listener());
}

/** Whether cash cost stays visible while subscription usage is shown. Off by default. */
export function useShowCostWithUsage(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
