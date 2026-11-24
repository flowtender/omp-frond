type SettingsDetailSection = "skills" | "plugins" | "mcp" | "models";
export type OmpSettingsShortcut = "models" | "mcp";

const STORAGE_KEY = "pi-web:settings-navigation";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SettingsNavigationState {
  selections?: Record<string, string>;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readState(storage: StorageLike): SettingsNavigationState {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state = parsed as SettingsNavigationState;
    return {
      selections: state.selections !== null
        && typeof state.selections === "object"
        && !Array.isArray(state.selections)
        ? state.selections
        : undefined,
    };
  } catch {
    return {};
  }
}

function selectionKey(section: SettingsDetailSection, cwd?: string | null): string | null {
  if (section === "models") return section;
  if (cwd) return JSON.stringify([section, cwd]);
  // MCP works without a project; its selection then lives under the bare name,
  // which no project key (always an array) can collide with.
  return section === "mcp" ? section : null;
}

export function getLastSettingsSelection(
  section: SettingsDetailSection,
  cwd?: string | null,
  storage: StorageLike | null = getBrowserStorage(),
): string | null {
  if (!storage) return null;
  const key = selectionKey(section, cwd);
  if (!key) return null;
  try {
    const value = readState(storage).selections?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setLastSettingsSelection(
  section: SettingsDetailSection,
  value: string,
  cwd?: string | null,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage || !value) return;
  const key = selectionKey(section, cwd);
  if (!key) return;
  try {
    const state = readState(storage);
    state.selections = { ...state.selections, [key]: value };
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browser storage is best-effort.
  }
}
