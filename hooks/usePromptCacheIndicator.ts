import { useSyncExternalStore } from "react";
import {
  parsePromptCacheIndicatorSettings,
  PROMPT_CACHE_INDICATOR_DEFAULTS,
  type PromptCacheIndicatorSettings,
} from "@/lib/prompt-cache-shared";

export const PROMPT_CACHE_INDICATOR_STORAGE_KEY = "omp-prompt-cache-indicator";

function readStored(): PromptCacheIndicatorSettings {
  try {
    return parsePromptCacheIndicatorSettings(window.localStorage.getItem(PROMPT_CACHE_INDICATOR_STORAGE_KEY));
  } catch {
    return PROMPT_CACHE_INDICATOR_DEFAULTS;
  }
}

let settings: PromptCacheIndicatorSettings | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): PromptCacheIndicatorSettings {
  settings ??= readStored();
  return settings;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

// Another tab chose; `key` is null when that tab cleared its storage.
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== PROMPT_CACHE_INDICATOR_STORAGE_KEY) return;
  settings = readStored();
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    // Nobody listened for another tab's choice meanwhile.
    settings = readStored();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setPromptCacheIndicatorSettings(patch: Partial<PromptCacheIndicatorSettings>): void {
  settings = { ...getSnapshot(), ...patch };
  try {
    window.localStorage.setItem(PROMPT_CACHE_INDICATOR_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Applies in memory even if the browser cannot save it.
  }
  notify();
}

/** The prompt-cache marker's settings: which sessions show one, and how it is drawn. */
export function usePromptCacheIndicatorSettings(): PromptCacheIndicatorSettings {
  return useSyncExternalStore(subscribe, getSnapshot, () => PROMPT_CACHE_INDICATOR_DEFAULTS);
}
