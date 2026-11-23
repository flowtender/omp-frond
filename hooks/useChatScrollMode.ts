import { useSyncExternalStore } from "react";

export type ChatScrollMode = "follow" | "anchor";

export const CHAT_SCROLL_MODE_STORAGE_KEY = "pi-chat-scroll-mode";
export const CHAT_SCROLL_MODE_DEFAULT: ChatScrollMode = "follow";

function readStoredMode(): ChatScrollMode {
  try {
    const raw = window.localStorage.getItem(CHAT_SCROLL_MODE_STORAGE_KEY);
    return raw === "anchor" ? "anchor" : "follow";
  } catch {
    return CHAT_SCROLL_MODE_DEFAULT;
  }
}

let mode: ChatScrollMode | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): ChatScrollMode {
  if (mode === null) mode = readStoredMode();
  return mode;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setChatScrollMode(next: ChatScrollMode): void {
  mode = next;
  try {
    window.localStorage.setItem(CHAT_SCROLL_MODE_STORAGE_KEY, next);
  } catch {}
  listeners.forEach((listener) => listener());
}

export function useChatScrollMode(): ChatScrollMode {
  return useSyncExternalStore(subscribe, getSnapshot, () => CHAT_SCROLL_MODE_DEFAULT);
}
