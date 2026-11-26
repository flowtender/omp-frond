import { PYTHON_FORMAT_MAX_CHARS, type PythonFormatterChoice } from "./python-format-shared";

export async function formatEvalJavaScript(source: string): Promise<string> {
  if (/^\s*%/.test(source)) return source;
  try {
    const [{ format }, babel, estree] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ]);
    const formatted = await format(source, { parser: "babel", plugins: [babel.default, estree.default] });
    return source.endsWith("\n") ? formatted : formatted.replace(/\n$/, "");
  } catch {
    // A cell may be incomplete or use syntax the formatter doesn't recognize.
    return source;
  }
}

export interface PythonFormatRequest {
  cwd?: string;
  formatter: PythonFormatterChoice;
}

const MAX_PYTHON_CACHE_ENTRIES = 200;
const pythonFormatCache = new Map<string, Promise<string>>();

async function requestPythonFormat(source: string, { cwd, formatter }: PythonFormatRequest): Promise<string | null> {
  try {
    const response = await fetch("/api/format/python", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, cwd, formatter }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { formatted?: unknown };
    return typeof data.formatted === "string" ? data.formatted : source;
  } catch {
    return null;
  }
}

/**
 * The cell as the machine's own Python formatter lays it out, or the cell itself
 * when there is no formatter, the cell is not valid Python, or it is a `%` command.
 * Answers are kept per source, so re-rendering a card asks the server once.
 */
export function formatEvalPython(source: string, request: PythonFormatRequest): Promise<string> {
  if (/^\s*%/.test(source) || source.length > PYTHON_FORMAT_MAX_CHARS) return Promise.resolve(source);
  const key = `${request.formatter}\0${request.cwd ?? ""}\0${source}`;
  const cached = pythonFormatCache.get(key);
  if (cached) return cached;
  const pending = requestPythonFormat(source, request).then((formatted) => {
    // A failed request is not remembered: the formatter may be reachable next time.
    if (formatted === null) pythonFormatCache.delete(key);
    return formatted ?? source;
  });
  pythonFormatCache.set(key, pending);
  if (pythonFormatCache.size > MAX_PYTHON_CACHE_ENTRIES) {
    const oldest = pythonFormatCache.keys().next().value;
    if (oldest !== undefined) pythonFormatCache.delete(oldest);
  }
  return pending;
}
