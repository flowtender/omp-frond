import { useSyncExternalStore } from "react";

export type ToolDisplayPreference = "compactJson" | "readPreviews" | "wideDiff";

const eventName = "omp-tool-display-changed";
const storageKey = (kind: ToolDisplayPreference) => `omp-tool-display-${kind}`;

function subscribe(listener: () => void): () => void {
  window.addEventListener(eventName, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useToolDisplayPreference(kind: ToolDisplayPreference): boolean {
  return useSyncExternalStore(subscribe, () => {
    try { return window.localStorage.getItem(storageKey(kind)) === "true"; }
    catch { return false; }
  }, () => false);
}

export function setToolDisplayPreference(kind: ToolDisplayPreference, enabled: boolean): void {
  try { window.localStorage.setItem(storageKey(kind), String(enabled)); }
  catch { return; }
  window.dispatchEvent(new Event(eventName));
}
