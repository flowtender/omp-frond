"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { DisplaySettings } from "@/lib/settings-api";

const DEFAULTS: DisplaySettings = { hideThinkingBlock: false, cacheMissMarker: false };

const listeners = new Set<() => void>();
let state: DisplaySettings = DEFAULTS;
let requestId = 0;

function emit(): void {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): DisplaySettings {
  return state;
}

function getServerSnapshot(): DisplaySettings {
  return DEFAULTS;
}

/**
 * Re-read the render-affecting settings from omp's config. Called on mount and
 * again whenever the Settings panel writes one of them, so a toggle applies to
 * the open transcript instead of waiting for a reload.
 */
export async function refreshDisplaySettings(cwd?: string | null): Promise<void> {
  const id = ++requestId;
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const response = await fetch(`/api/display-settings${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Display settings request failed (${response.status})`);
  const answer = await response.json() as Partial<DisplaySettings>;
  // A slower earlier request must not overwrite a newer answer.
  if (id !== requestId) return;
  const next: DisplaySettings = {
    hideThinkingBlock: answer.hideThinkingBlock === true,
    cacheMissMarker: answer.cacheMissMarker === true,
  };
  if (next.hideThinkingBlock === state.hideThinkingBlock && next.cacheMissMarker === state.cacheMissMarker) return;
  state = next;
  emit();
}

/** Read the current values. Every consumer re-renders when they change. */
export function useDisplaySettings(): DisplaySettings {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Read the values and keep them in sync with omp's config for `cwd`. Mount
 * this once per view (the store is shared) so message components can use the
 * read-only hook without each one issuing a request.
 */
export function useSyncedDisplaySettings(cwd?: string | null): DisplaySettings {
  const snapshot = useDisplaySettings();

  useEffect(() => {
    // Keep the last known values when the read fails; they are only cosmetic.
    void refreshDisplaySettings(cwd).catch(() => {});
  }, [cwd]);

  return snapshot;
}
