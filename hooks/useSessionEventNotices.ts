import {
  parseSessionEventNoticeSettings,
  SESSION_EVENT_NOTICE_DEFAULTS,
} from "@/lib/session-event-notice-settings";
import { createLocalSettingsStore } from "./createLocalSettingsStore";

const store = createLocalSettingsStore({
  key: "omp-session-event-notices",
  defaults: SESSION_EVENT_NOTICE_DEFAULTS,
  parse: parseSessionEventNoticeSettings,
});

export const setSessionEventNoticeSettings = store.setSettings;

/** Which model-usage, model, thinking-level and service-tier lines the chat draws. */
export const useSessionEventNoticeSettings = store.useSettings;
