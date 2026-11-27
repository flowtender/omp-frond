import { randomUUID } from "crypto";
import { homedir } from "os";
import type { IPty, spawn as spawnNodePty } from "node-pty";
import { samePath } from "./paths";

export type TerminalEvent =
  | { type: "output"; data: string; offset: number; reset?: boolean }
  | { type: "exit"; exitCode: number }
  | { type: "closed" };

type TerminalListener = (event: TerminalEvent) => void;
type TerminalProcess = Pick<IPty, "write" | "resize"> & { kill(signal?: "SIGKILL"): void };

interface TerminalRecord {
  pty: TerminalProcess;
  cwd: string;
  listeners: Set<TerminalListener>;
  backlog: string;
  offset: number;
  exited: boolean;
  exitCode: number | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

declare global {
  var __piWebTerminals: Map<string, TerminalRecord> | undefined;
}

// ponytail: bounded replay; use terminal serialization if full-screen snapshots become necessary.
const MAX_BACKLOG = 128 * 1024;
export const TERMINAL_RECONNECT_MS = 120_000;

function registry(): Map<string, TerminalRecord> {
  if (!globalThis.__piWebTerminals) {
    globalThis.__piWebTerminals = new Map();
    const shutdown = () => {
      for (const id of globalThis.__piWebTerminals!.keys()) killTerminal(id, true);
    };
    process.once("exit", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return globalThis.__piWebTerminals;
}

function shellEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // The browser login password guards this server, not the shells it starts.
    const comparableKey = process.platform === "win32" ? key.toUpperCase() : key;
    if (value !== undefined && comparableKey !== "OMP_FROND_PASSWORD") env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // Windows shells (Git Bash / MSYS2, cmd, PowerShell) otherwise inherit the
  // system ANSI codepage (e.g. GBK on zh-CN) and mangle non-ASCII filenames.
  if (!process.env.LANG && !process.env.LC_ALL && !process.env.LC_CTYPE) env.LANG = "C.UTF-8";
  return env;
}

function emit(record: TerminalRecord, event: TerminalEvent): void {
  for (const listener of record.listeners) listener(event);
}

function scheduleCleanup(id: string, record: TerminalRecord): void {
  if (record.cleanupTimer || record.listeners.size || registry().get(id) !== record) return;
  record.cleanupTimer = setTimeout(() => killTerminal(id), TERMINAL_RECONNECT_MS);
  record.cleanupTimer.unref?.();
}

function dimension(value: number, fallback: number): number {
  return Math.min(1000, Math.max(2, Number.isFinite(value) ? Math.floor(value) : fallback));
}

function spawnWorkspaceShell(
  cwd: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): TerminalProcess {
  const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : process.env.SHELL || "/bin/sh";
  const args = process.platform === "win32" ? [] : ["-l"];
  const env = shellEnvironment();
  if (process.platform === "linux" && typeof Bun !== "undefined") {
    // node-pty shells receive an early SIGHUP under Bun on Linux.
    const decoder = new TextDecoder();
    let streamClosed = false;
    let finishAfterClose: (() => void) | undefined;
    const child = Bun.spawn([shell, ...args], {
      cwd,
      env,
      terminal: {
        cols,
        rows,
        data(_terminal, bytes) {
          const text = decoder.decode(bytes, { stream: true });
          if (text) onData(text);
        },
        exit() {
          streamClosed = true;
          finishAfterClose?.();
        },
      },
    });
    const terminal = child.terminal!;
    const processExited = (exitCode: number) => {
      let timeout: NodeJS.Timeout | undefined;
      const finish = () => {
        clearTimeout(timeout);
        finishAfterClose = undefined;
        terminal.close();
        const tail = decoder.decode();
        if (tail) onData(tail);
        onExit(exitCode);
      };
      if (streamClosed) finish();
      else {
        // Drain final output, but do not wait on a grandchild holding the PTY open.
        finishAfterClose = finish;
        timeout = setTimeout(finish, 200);
      }
    };
    void child.exited.then(processExited, () => processExited(1));
    return {
      write: (data) => terminal.write(data),
      resize: (width, height) => terminal.resize(width, height),
      kill: (signal) => child.kill(signal ?? "SIGHUP"),
    };
  }

  let spawn: typeof spawnNodePty;
  try {
    // Load inside creation so native module failures reach the API's JSON error handler.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ spawn } = require("node-pty") as { spawn: typeof spawnNodePty });
  } catch (error) {
    throw new Error(
      `Cannot load the node-pty native terminal module for ${process.platform}-${process.arch}. ` +
      "The binary may be missing or incompatible. In the omp-frond installation directory " +
      "(the npx cache directory when using npx), run: npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts. " +
      "On Debian/Ubuntu, install build tools first: sudo apt-get install -y python3 build-essential. " +
      `Then restart omp-frond. Original error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const pty = spawn(shell, args, { name: "xterm-256color", cols, rows, cwd, env });
  pty.onData(onData);
  pty.onExit(({ exitCode }) => onExit(exitCode));
  return pty;
}

export function createTerminal(cwd: string, cols: number, rows: number, id: string = randomUUID()): string {
  const existing = registry().get(id);
  if (existing) {
    if (!samePath(existing.cwd, cwd)) throw new Error("Terminal belongs to a different workspace");
    return id;
  }
  const onData = (data: string) => {
    record.backlog = (record.backlog + data).slice(-MAX_BACKLOG);
    record.offset += data.length;
    emit(record, { type: "output", data, offset: record.offset });
  };
  const onExit = (exitCode: number) => {
    clearTimeout(record.cleanupTimer ?? undefined);
    record.cleanupTimer = null;
    record.exited = true;
    record.exitCode = exitCode;
    emit(record, { type: "exit", exitCode });
    scheduleCleanup(id, record);
  };
  const record: TerminalRecord = {
    pty: spawnWorkspaceShell(cwd || homedir(), dimension(cols, 80), dimension(rows, 24), onData, onExit),
    cwd,
    listeners: new Set(),
    backlog: "",
    offset: 0,
    exited: false,
    exitCode: null,
    cleanupTimer: null,
  };
  registry().set(id, record);
  // Includes creations whose response or initial SSE connection never arrives.
  scheduleCleanup(id, record);
  return id;
}

export function hasTerminal(id: string): boolean {
  return registry().has(id);
}

export function getTerminalCwd(id: string): string | undefined {
  return registry().get(id)?.cwd;
}

export function subscribeTerminal(
  id: string,
  listener: TerminalListener,
  after?: number,
): { output: Extract<TerminalEvent, { type: "output" }>; exited: boolean; exitCode: number | null; unsubscribe: () => void } | null {
  const record = registry().get(id);
  if (!record) return null;
  record.listeners.add(listener);
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  record.cleanupTimer = null;
  const start = record.offset - record.backlog.length;
  const reset = after === undefined || after < start || after > record.offset;
  return {
    output: {
      type: "output",
      data: reset ? record.backlog : record.backlog.slice(after - start),
      offset: record.offset,
      reset,
    },
    exited: record.exited,
    exitCode: record.exitCode,
    unsubscribe: () => {
      record.listeners.delete(listener);
      scheduleCleanup(id, record);
    },
  };
}

export function writeTerminal(id: string, data: string): boolean {
  const record = registry().get(id);
  if (!record || record.exited) return false;
  record.pty.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const record = registry().get(id);
  if (!record || record.exited) return false;
  record.pty.resize(dimension(cols, 80), dimension(rows, 24));
  return true;
}

export function killTerminal(id: string, force = false): boolean {
  const record = registry().get(id);
  if (!record) return false;
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  registry().delete(id);
  if (!record.exited) {
    record.pty.kill(force ? "SIGKILL" : undefined);
    // A shell may trap SIGHUP; explicit close and lease expiry must still finish.
    if (!force) {
      record.cleanupTimer = setTimeout(() => {
        if (!record.exited) record.pty.kill("SIGKILL");
      }, 2000);
      record.cleanupTimer.unref?.();
    }
  }
  emit(record, { type: "closed" });
  record.listeners.clear();
  return true;
}
