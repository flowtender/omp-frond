import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProjectExecutableResource } from "./api-types";
import { isPathWithinRoots } from "./path-security";
import { readRegularFileText } from "./regular-file";

const CONFIG_DIRS = [".omp", ".pi", ".claude", ".agents", ".codex"];
const MODULE = /\.(?:[cm]?ts|[cm]?js)$/;
const HOOK = /\.(?:[cm]?ts|[cm]?js|sh|bash|py|ps1|cmd|bat)$/;
const MCP_FILES = [
  "mcp.json", ".mcp.json", ".omp/mcp.json", ".omp/.mcp.json", ".pi/mcp.json",
  ".claude/mcp.json", ".claude/.mcp.json", ".cursor/mcp.json", ".vscode/mcp.json",
  ".windsurf/mcp_config.json",
];
const MAX_CONFIG_BYTES = 1024 * 1024;

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Only inspect metadata or parse inert configuration. A link out of the checkout is listed, never read. */
export function listProjectExecutableResources(cwd: string, checkoutRoot: string): ProjectExecutableResource[] {
  const resources: ProjectExecutableResource[] = [];
  const roots = new Set([checkoutRoot]);
  const add = (kind: ProjectExecutableResource["kind"], path: string) => {
    resources.push({ kind, path: relative(checkoutRoot, path) });
  };

  function target(kind: ProjectExecutableResource["kind"], path: string): string | undefined {
    try {
      const actual = realpathSync(path);
      if (isPathWithinRoots(actual, roots)) return actual;
      add(kind, path);
    } catch (error) {
      if (!missing(error) || lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) add(kind, path);
    }
  }

  function modules(kind: "tool" | "extension" | "hook", path: string, packages = false): void {
    const realPath = target(kind, path);
    if (!realPath) return;
    try {
      for (const entry of readdirSync(realPath, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const entryPath = join(path, entry.name);
        const name = entry.name;
        if (!entry.isDirectory() && (kind === "hook" ? HOOK : MODULE).test(name) && !name.endsWith(".d.ts")) {
          if (entry.isFile() || entry.isSymbolicLink()) add(kind, entryPath);
        } else if (packages && (entry.isDirectory() || entry.isSymbolicLink())) {
          const index = join(entryPath, "index.ts");
          const realIndex = target(kind, index);
          if (realIndex && statSync(realIndex).isFile()) add(kind, index);
        }
      }
    } catch (error) {
      if (!missing(error)) add(kind, path);
    }
  }

  function config(path: string, kind: "extension" | "hook" | "mcp", keys: readonly string[], yaml = false): void {
    const realPath = target(kind, path);
    if (!realPath) return;
    try {
      const text = readRegularFileText(realPath, MAX_CONFIG_BYTES, { noFollow: true });
      if (text === undefined) return;
      const data: Record<string, unknown> | null = yaml ? parseYaml(text) : JSON.parse(text);
      if (data === null || typeof data !== "object") return;
      const hasEntries = (value: unknown) => value != null && typeof value === "object" && Object.keys(value).length > 0;
      const vscode = data.mcp as { servers?: unknown } | undefined;
      if (keys.some((key) => hasEntries(data[key])) ||
        (kind === "mcp" && hasEntries(vscode?.servers))) add(kind, path);
    } catch {
      // Unknown or malformed executable configuration does not imply permission to load it.
      add(kind, path);
    }
  }

  for (let dir = cwd; isPathWithinRoots(dir, roots); dir = dirname(dir)) {
    for (const base of CONFIG_DIRS) {
      const root = join(dir, base);
      modules("tool", join(root, "tools"), true);
      modules("extension", join(root, "extensions"), true);
      const hooks = join(root, "hooks");
      modules("hook", hooks);
      modules("hook", join(hooks, "pre"));
      modules("hook", join(hooks, "post"));
      config(join(root, "hooks.json"), "hook", ["hooks"]);
    }
    config(join(dir, ".omp", "config.yml"), "extension", ["extensions"], true);
    config(join(dir, ".omp", "config.yaml"), "extension", ["extensions"], true);
    for (const base of [".omp", ".pi", ".claude"]) {
      const path = join(dir, base, "settings.json");
      config(path, "extension", ["extensions", "packages", "enabledPlugins"]);
      config(path, "hook", ["hooks"]);
    }
    for (const file of MCP_FILES) config(join(dir, file), "mcp", ["mcpServers", "servers"]);
    config(join(dir, ".gemini", "settings.json"), "mcp", ["mcpServers"]);
    if (dir === checkoutRoot || dirname(dir) === dir) break;
  }
  return resources.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}
