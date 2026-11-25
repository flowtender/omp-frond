import { useSyncExternalStore } from "react";

export type ExpansionKind = "thinking" | "tools" | "process" | "compaction";
export type ExpansionMode = "expanded" | "collapsed" | "failed" | "automatic";

const defaults: Record<ExpansionKind, ExpansionMode> = {
  thinking: "collapsed",
  tools: "collapsed",
  process: "automatic",
  compaction: "collapsed",
};
const eventName = "pi-expansion-preference-changed";
const storageKey = (kind: ExpansionKind) => `pi-expansion-${kind}`;

function validMode(kind: ExpansionKind, value: string | null): value is ExpansionMode {
  return value === "expanded" || value === "collapsed"
    || (kind === "tools" && value === "failed")
    || (kind === "process" && value === "automatic");
}

export function getExpansionPreference(kind: ExpansionKind): ExpansionMode {
  if (typeof window === "undefined") return defaults[kind];
  try {
    const value = window.localStorage.getItem(storageKey(kind));
    if (validMode(kind, value)) return value;
    if (kind === "thinking" && value === null) {
      return window.localStorage.getItem("pi-thinking-expanded") === "true" ? "expanded" : "collapsed";
    }
  } catch {}
  return defaults[kind];
}

export function setExpansionPreference(kind: ExpansionKind, mode: ExpansionMode): void {
  if (typeof window === "undefined" || !validMode(kind, mode)) return;
  try {
    window.localStorage.setItem(storageKey(kind), mode);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(eventName));
}

export function subscribeExpansionPreference(listener: () => void): () => void {
  window.addEventListener(eventName, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useExpansionPreference(kind: ExpansionKind): ExpansionMode {
  return useSyncExternalStore(
    subscribeExpansionPreference,
    () => getExpansionPreference(kind),
    () => defaults[kind],
  );
}
