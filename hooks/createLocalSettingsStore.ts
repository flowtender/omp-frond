import { useSyncExternalStore } from "react";

/**
 * A per-browser settings object kept as one JSON value in localStorage, shared
 * by every component that reads it and followed across tabs.
 */
export function createLocalSettingsStore<T extends object>({ key, defaults, parse }: {
  key: string;
  defaults: T;
  parse: (raw: string | null) => T;
}) {
  function readStored(): T {
    try {
      return parse(window.localStorage.getItem(key));
    } catch {
      return defaults;
    }
  }

  let settings: T | null = null;
  const listeners = new Set<() => void>();

  function getSnapshot(): T {
    settings ??= readStored();
    return settings;
  }

  function notify(): void {
    listeners.forEach((listener) => listener());
  }

  // Another tab chose; `key` is null when that tab cleared its storage.
  function onStorage(event: StorageEvent): void {
    if (event.key !== null && event.key !== key) return;
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

  return {
    useSettings: (): T => useSyncExternalStore(subscribe, getSnapshot, () => defaults),
    setSettings(patch: Partial<T>): void {
      settings = { ...getSnapshot(), ...patch };
      try {
        window.localStorage.setItem(key, JSON.stringify(settings));
      } catch {
        // Applies in memory even if the browser cannot save it.
      }
      notify();
    },
  };
}
