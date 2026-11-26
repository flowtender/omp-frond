import { useSyncExternalStore } from "react";

export const TOKEN_DISPLAY_MODES = ["flow", "text", "off"] as const;
export type TokenDisplayMode = typeof TOKEN_DISPLAY_MODES[number];

const storageKey = "omp-token-display";
const changeEvent = "omp-token-display-changed";
const defaultMode = () => "text" as const;

function readMode(): TokenDisplayMode {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === "flow" || value === "off" ? value : defaultMode();
  } catch {
    return defaultMode();
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(changeEvent, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("storage", listener);
  };
}

export function setTokenDisplay(mode: TokenDisplayMode): void {
  try { window.localStorage.setItem(storageKey, mode); }
  catch { return; }
  window.dispatchEvent(new Event(changeEvent));
}

export function useTokenDisplay(): TokenDisplayMode {
  return useSyncExternalStore(subscribe, readMode, defaultMode);
}
