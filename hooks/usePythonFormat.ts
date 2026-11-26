import { useEffect, useState, useSyncExternalStore } from "react";
import {
  parsePythonFormatSettings,
  PYTHON_FORMAT_DEFAULTS,
  type InstalledPythonFormatters,
  type PythonFormatSettings,
} from "@/lib/python-format-shared";

export const PYTHON_FORMAT_STORAGE_KEY = "omp-python-format";

function readStored(): PythonFormatSettings {
  try {
    return parsePythonFormatSettings(window.localStorage.getItem(PYTHON_FORMAT_STORAGE_KEY));
  } catch {
    return PYTHON_FORMAT_DEFAULTS;
  }
}

let settings: PythonFormatSettings | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): PythonFormatSettings {
  settings ??= readStored();
  return settings;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

// Another tab chose; `key` is null when that tab cleared its storage.
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== PYTHON_FORMAT_STORAGE_KEY) return;
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

export function setPythonFormatSettings(patch: Partial<PythonFormatSettings>): void {
  settings = { ...getSnapshot(), ...patch };
  try {
    window.localStorage.setItem(PYTHON_FORMAT_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Applies in memory even if the browser cannot save it.
  }
  notify();
}

/** Whether Python eval cells are shown formatted, and by which formatter. Off by default. */
export function usePythonFormatSettings(): PythonFormatSettings {
  return useSyncExternalStore(subscribe, getSnapshot, () => PYTHON_FORMAT_DEFAULTS);
}

/** Which formatters the server's machine has; null until it answers or when it cannot. */
export function useInstalledPythonFormatters(): InstalledPythonFormatters | null {
  const [installed, setInstalled] = useState<InstalledPythonFormatters | null>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/format/python")
      .then(async (response) => {
        const data = await response.json() as { installed?: InstalledPythonFormatters };
        if (active && response.ok && data.installed) setInstalled(data.installed);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return installed;
}
