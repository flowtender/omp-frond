import { spawn } from "child_process";
import path from "path";
import {
  PYTHON_FORMAT_MAX_CHARS,
  PYTHON_FORMATTERS,
  resolvePythonFormatter,
  type InstalledPythonFormatters,
  type PythonFormatterChoice,
  type PythonFormatterName,
} from "./python-format-shared";

const FORMAT_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
const INSTALLED_TTL_MS = 10_000;
const MAX_OUTPUT_CHARS = 2 * PYTHON_FORMAT_MAX_CHARS;

interface RunResult {
  code: number | null;
  stdout: string;
}

/** Runs a program without a shell. Null when it cannot start, times out or floods its output. */
function run(command: string, args: string[], cwd: string, timeoutMs: number, input?: string): Promise<RunResult | null> {
  const { promise, resolve } = Promise.withResolvers<RunResult | null>();
  let child;
  try {
    child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "ignore"], timeout: timeoutMs, windowsHide: true });
  } catch {
    resolve(null);
    return promise;
  }
  let stdout = "";
  let overflowed = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.length > MAX_OUTPUT_CHARS) {
      overflowed = true;
      child.kill();
    }
  });
  child.on("error", () => resolve(null));
  child.on("close", (code, signal) => resolve(overflowed || signal ? null : { code, stdout }));
  // A formatter that exits before reading its input breaks the pipe; its exit code says so.
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return promise;
}

let installedCache: { at: number; value: InstalledPythonFormatters } | undefined;

export async function installedPythonFormatters(cwd: string): Promise<InstalledPythonFormatters> {
  const now = Date.now();
  if (installedCache && now - installedCache.at < INSTALLED_TTL_MS) return installedCache.value;
  const probes = await Promise.all(PYTHON_FORMATTERS.map((name) => run(name, ["--version"], cwd, PROBE_TIMEOUT_MS)));
  const value = Object.fromEntries(
    PYTHON_FORMATTERS.map((name, index) => [name, probes[index]?.code === 0]),
  ) as InstalledPythonFormatters;
  installedCache = { at: now, value };
  return value;
}

// The stdin filename places the cell in the project, so the formatter finds the
// project's own pyproject.toml / ruff.toml settings as it would for a real file.
function formatterArguments(name: PythonFormatterName, cellPath: string): string[] {
  return name === "ruff"
    ? ["format", "--stdin-filename", cellPath, "-"]
    : ["-q", "--stdin-filename", cellPath, "-"];
}

/**
 * The formatted source, or null when no formatter applies or the formatter
 * refused it (a syntax error exits non-zero in both ruff and black).
 */
export async function formatPythonSource(
  source: string,
  cwd: string,
  choice: PythonFormatterChoice,
): Promise<string | null> {
  if (source.length > PYTHON_FORMAT_MAX_CHARS) return null;
  const name = resolvePythonFormatter(choice, await installedPythonFormatters(cwd));
  if (!name) return null;
  const result = await run(name, formatterArguments(name, path.join(cwd, "eval-cell.py")), cwd, FORMAT_TIMEOUT_MS, source);
  if (!result || result.code !== 0 || result.stdout === "") return null;
  return source.endsWith("\n") ? result.stdout : result.stdout.replace(/\n$/, "");
}
