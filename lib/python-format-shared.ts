// Client-safe rules of the Python eval formatter: which formatters exist and how the
// per-browser setting is stored. The server half is `lib/python-formatter.ts`.

export const PYTHON_FORMATTERS = ["ruff", "black"] as const;
export type PythonFormatterName = typeof PYTHON_FORMATTERS[number];

/** `auto` takes the first installed formatter in `PYTHON_FORMATTERS` order. */
export type PythonFormatterChoice = "auto" | PythonFormatterName;

export interface PythonFormatSettings {
  enabled: boolean;
  formatter: PythonFormatterChoice;
}

export const PYTHON_FORMAT_DEFAULTS: PythonFormatSettings = { enabled: false, formatter: "auto" };

/** Sources longer than this are never sent to a formatter. */
export const PYTHON_FORMAT_MAX_CHARS = 100_000;

export type InstalledPythonFormatters = Record<PythonFormatterName, boolean>;

export function parsePythonFormatSettings(raw: string | null): PythonFormatSettings {
  if (!raw) return PYTHON_FORMAT_DEFAULTS;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return PYTHON_FORMAT_DEFAULTS;
    const { enabled, formatter } = value as Record<string, unknown>;
    return {
      enabled: enabled === true,
      formatter: formatter === "ruff" || formatter === "black" ? formatter : "auto",
    };
  } catch {
    return PYTHON_FORMAT_DEFAULTS;
  }
}

/** The formatter a choice resolves to, or null when none of the wanted ones is installed. */
export function resolvePythonFormatter(
  choice: PythonFormatterChoice,
  installed: InstalledPythonFormatters,
): PythonFormatterName | null {
  if (choice !== "auto") return installed[choice] ? choice : null;
  return PYTHON_FORMATTERS.find((name) => installed[name]) ?? null;
}
