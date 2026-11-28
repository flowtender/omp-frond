import {
  parsePromptCacheIndicatorSettings,
  PROMPT_CACHE_INDICATOR_DEFAULTS,
} from "@/lib/prompt-cache-shared";
import { createLocalSettingsStore } from "./createLocalSettingsStore";

export const PROMPT_CACHE_INDICATOR_STORAGE_KEY = "omp-prompt-cache-indicator";

const store = createLocalSettingsStore({
  key: PROMPT_CACHE_INDICATOR_STORAGE_KEY,
  defaults: PROMPT_CACHE_INDICATOR_DEFAULTS,
  parse: parsePromptCacheIndicatorSettings,
});

export const setPromptCacheIndicatorSettings = store.setSettings;

/** The prompt-cache marker's settings: which sessions show one, and how it is drawn. */
export const usePromptCacheIndicatorSettings = store.useSettings;
