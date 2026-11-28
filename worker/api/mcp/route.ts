import { existsSync, mkdirSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { setMcpServerEnabled } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isPathWithinRoots, resolveRealRoots } from "@/lib/path-security";
import { readRegularFileText } from "@/lib/regular-file";
import { maskArgs, maskCommand, maskUrl, SECRET_MASK } from "@/lib/mcp-secrets";
import { readProjectMcpListing } from "@/lib/project-mcp-listing";
import { listProjectExecutableResources } from "@/lib/project-resource-inventory";
import { resolveProjectTrustRoot } from "@/lib/worktree";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import type { McpConfigResponse, McpScopeConfig, McpServerConfig, McpServerEntry } from "@/lib/settings-api";


const SERVER_NAME = /^[a-zA-Z0-9_.:-]{1,100}$/;
const REDACTED_VALUE = "••••••••";
const MAX_BYTES = 1024 * 1024;
const MAX_SERVERS = 200;
const SERVER_KEYS: Record<string, true> = {
  enabled: true,
  timeout: true,
  type: true,
  command: true,
  args: true,
  env: true,
  cwd: true,
  url: true,
  headers: true,
  auth: true,
  oauth: true,
};

type McpDocument = {
  $schema?: string;
  mcpServers?: Record<string, McpServerConfig>;
  disabledServers?: string[];
  enabledServers?: string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactNested(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "number") return REDACTED_VALUE;
  if (Array.isArray(value)) return value.map(redactNested);
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactNested(item)]));
  return value;
}

function redactConfig(config: McpServerConfig): McpServerConfig {
  const result: McpServerConfig = {};
  if (typeof config.enabled === "boolean") result.enabled = config.enabled;
  if (typeof config.timeout === "number") result.timeout = config.timeout;
  if (config.type === "stdio" || config.type === "http" || config.type === "sse") result.type = config.type;
  if (typeof config.command === "string") result.command = maskCommand(config.command).value;
  if (Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string")) result.args = maskArgs(config.args).args;
  if (typeof config.url === "string") result.url = maskUrl(config.url).value;
  if (typeof config.cwd === "string") result.cwd = maskCommand(config.cwd).value;
  if (record(config.env)) result.env = Object.fromEntries(Object.keys(config.env).map((key) => [key, REDACTED_VALUE]));
  if (record(config.headers)) result.headers = Object.fromEntries(Object.keys(config.headers).map((key) => [key, REDACTED_VALUE]));
  if (record(config.auth)) result.auth = redactNested(config.auth) as Record<string, unknown>;
  if (record(config.oauth)) result.oauth = redactNested(config.oauth) as Record<string, unknown>;
  return result;
}

function restoreRedactedValues(submitted: unknown, existing: unknown, path: string, projected: unknown): unknown {
  if (typeof submitted === "string" && (submitted.includes(REDACTED_VALUE) || submitted.includes(SECRET_MASK))) {
    if (existing === undefined || submitted !== projected) throw new Error(`${path}: re-enter the stored value instead of editing a redaction`);
    return existing;
  }
  if (Array.isArray(submitted)) {
    const previous = Array.isArray(existing) ? existing : [];
    const shown = Array.isArray(projected) ? projected : [];
    return submitted.map((item, index) => restoreRedactedValues(item, previous[index], `${path}[${index}]`, shown[index]));
  }
  if (submitted && typeof submitted === "object") {
    const previous = existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {};
    const shown = record(projected) ? projected : {};
    return Object.fromEntries(Object.entries(submitted).map(([key, value]) => [
      key,
      restoreRedactedValues(value, previous[key], `${path}.${key}`, shown[key]),
    ]));
  }
  return submitted;
}

function configPath(scope: "user" | "project", cwd?: string): string {
  return scope === "user" ? join(getAgentDir(), "mcp.json") : join(cwd!, ".omp", "mcp.json");
}

function readDocument(scope: "user" | "project", cwd: string | undefined, roots: Set<string>): McpDocument {
  const path = configPath(scope, cwd);
  let target = path;
  if (scope === "project") {
    try {
      target = realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read the MCP config.");
      // A missing file is safe only if its existing parent is inside the allowed roots.
      const parent = existsSync(dirname(path)) ? dirname(path) : cwd!;
      if (!isExistingFilePathAllowed(parent, roots)) throw new Error("MCP config target is outside the allowed folders.");
      return {};
    }
    if (!isPathWithinRoots(target, resolveRealRoots(roots))) throw new Error("MCP config target is outside the allowed folders.");
  }
  let text: string | undefined;
  try {
    text = readRegularFileText(target, MAX_BYTES, { noFollow: scope === "project" });
  } catch {
    throw new Error("Could not read the MCP config as a bounded regular file.");
  }
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The MCP config is not valid JSON.");
  }
  if (!record(parsed) || (parsed.mcpServers !== undefined && !record(parsed.mcpServers)) ||
      (parsed.disabledServers !== undefined && (!Array.isArray(parsed.disabledServers) || parsed.disabledServers.some((v) => typeof v !== "string"))) ||
      (parsed.enabledServers !== undefined && (!Array.isArray(parsed.enabledServers) || parsed.enabledServers.some((v) => typeof v !== "string")))) {
    throw new Error("Invalid MCP config shape.");
  }
  const servers = parsed.mcpServers as Record<string, unknown> | undefined;
  if (servers && (Object.keys(servers).length > MAX_SERVERS || Object.values(servers).some((value) => !record(value)))) {
    throw new Error("Invalid or excessive MCP server entries.");
  }
  return parsed as McpDocument;
}

function readScope(scope: "user" | "project", cwd: string | undefined, roots: Set<string>): { scope: McpScopeConfig; document: McpDocument } {
  const path = configPath(scope, cwd);
  try {
    const document = readDocument(scope, cwd, roots);
    const servers = Object.entries(document.mcpServers ?? {}).map(([name, config]) => ({
      name, config: redactConfig(config), enabled: config.enabled !== false, editable: true,
      source: { path, provider: "OMP", level: scope },
    }));
    return { scope: { scope, path, servers }, document };
  } catch (error) {
    return { scope: { scope, path, servers: [], error: error instanceof Error ? error.message : "Could not read the MCP config." }, document: {} };
  }
}

function applyEffectiveEnabledState(response: McpConfigResponse, document: McpDocument): void {
  const disabled = new Set(document.disabledServers ?? []);
  const forced = new Set(document.enabledServers ?? []);
  for (const scope of [response.user, response.project]) {
    for (const server of scope?.servers ?? []) {
      server.enabled = !disabled.has(server.name) && (server.config.enabled !== false || forced.has(server.name));
    }
  }
}

function validateStringRecord(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (Object.values(value).some((item) => typeof item !== "string")) throw new Error(`${label} values must be strings`);
}

function validateServer(entry: McpServerEntry): McpServerEntry {
  const name = entry.name.trim();
  if (!SERVER_NAME.test(name)) throw new Error(`Invalid MCP server name: ${name || "(empty)"}`);
  const config = entry.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${name}: config must be an object`);
  if (Object.hasOwn(config, "mcpServers")) {
    throw new Error(`${name}: paste only this server's configuration object, not the full mcp.json document. Remove the mcpServers wrapper and server-name key; enter the server name in the name field.`);
  }
  const unknown = Object.keys(config).find((key) => !SERVER_KEYS[key]);
  if (unknown) throw new Error(`${name}: unknown property ${unknown}`);
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error(`${name}: enabled must be boolean`);
  if (config.timeout !== undefined && (typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout < 0)) {
    throw new Error(`${name}: timeout must be a non-negative number`);
  }
  if (config.command && config.url) throw new Error(`${name}: choose command or URL, not both`);
  if (!config.command && !config.url) throw new Error(`${name}: command or URL is required`);
  if (config.command) {
    if (typeof config.command !== "string" || !config.command.trim()) throw new Error(`${name}: command is required`);
    if (config.type !== undefined && config.type !== "stdio") throw new Error(`${name}: command transport must be stdio`);
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string"))) {
      throw new Error(`${name}: args must be a string array`);
    }
    if (config.cwd !== undefined && typeof config.cwd !== "string") throw new Error(`${name}: cwd must be text`);
    validateStringRecord(config.env, `${name}: env`);
  } else {
    if (typeof config.url !== "string" || !config.url.trim()) throw new Error(`${name}: URL is required`);
    if (config.type !== "http" && config.type !== "sse") throw new Error(`${name}: URL transport must be http or sse`);
    validateStringRecord(config.headers, `${name}: headers`);
  }
  if (config.auth !== undefined && (!config.auth || typeof config.auth !== "object" || Array.isArray(config.auth))) {
    throw new Error(`${name}: auth must be an object`);
  }
  if (config.oauth !== undefined && (!config.oauth || typeof config.oauth !== "object" || Array.isArray(config.oauth))) {
    throw new Error(`${name}: oauth must be an object`);
  }
  return { name, config, enabled: config.enabled !== false };
}

async function validatedCwd(req: Request): Promise<{ cwd: string | undefined; roots: Set<string> }> {
  const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
  const roots = await getAllowedFileRoots();
  if (cwd && !isExistingFilePathAllowed(cwd, roots)) throw new Error("Access denied");
  return { cwd, roots };
}

async function addProjectPreviews(project: McpScopeConfig, cwd: string, roots: Set<string>): Promise<void> {
  const folder = realpathSync(cwd);
  const { checkoutRoot } = await resolveProjectTrustRoot(folder);
  const resources = listProjectExecutableResources(folder, checkoutRoot);
  const preview = readProjectMcpListing(folder, checkoutRoot, resources, roots, getAgentDir());
  const names = new Set(project.servers.map(({ name }) => name));
  for (const server of preview.mcpServers) {
    if (server.sourcePath === preview.mcpFile?.path || names.has(server.name)) continue;
    names.add(server.name);
    project.servers.push({
      name: server.name,
      enabled: server.enabled,
      editable: false,
      source: { path: server.sourcePath, provider: "MCP config", level: "project" },
      config: {
        enabled: server.enabled,
        type: server.transport,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        url: server.url,
        ...(server.envNames.length > 0 && { env: Object.fromEntries(server.envNames.map((name) => [name, REDACTED_VALUE])) }),
        ...(server.headerNames.length > 0 && { headers: Object.fromEntries(server.headerNames.map((name) => [name, REDACTED_VALUE])) }),
      },
    });
  }
}

export async function GET(req: Request) {
  try {
    const { cwd, roots } = await validatedCwd(req);
    const user = readScope("user", undefined, roots);
    const response: McpConfigResponse = {
      user: user.scope,
      project: cwd ? readScope("project", cwd, roots).scope : null,
    };
    if (cwd && response.project) await addProjectPreviews(response.project, cwd, roots);
    applyEffectiveEnabledState(response, user.document);
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: message === "Access denied" ? 403 : 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const { cwd, roots } = await validatedCwd(req);
    const body = await req.json() as {
      scope?: "user" | "project";
      name?: string;
      enabled?: boolean;
    };
    if (body.scope !== "user" && body.scope !== "project") throw new Error("Invalid MCP scope");
    if (body.scope === "project" && !cwd) throw new Error("cwd required for project MCP settings");
    if (typeof body.name !== "string" || !SERVER_NAME.test(body.name)) throw new Error("Invalid MCP server name");
    if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");

    const userPath = configPath("user");
    const projectPath = cwd ? configPath("project", cwd) : userPath;
    const scopedPath = body.scope === "user" ? userPath : projectPath;
    const scopedDocument = readDocument(body.scope, cwd, roots);
    const sourcePath = scopedDocument.mcpServers?.[body.name] ? scopedPath : undefined;
    // The writer may inspect both files even when the entry belongs to one.
    readDocument("user", undefined, roots);
    if (cwd) readDocument("project", cwd, roots);

    await setMcpServerEnabled({
      userPath,
      projectPath,
      sourcePath,
      name: body.name,
      enabled: body.enabled,
    });
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function PUT(req: Request) {
  try {
    const { cwd, roots } = await validatedCwd(req);
    const body = await req.json() as { scope?: "user" | "project"; servers?: McpServerEntry[] };
    if (body.scope !== "user" && body.scope !== "project") throw new Error("Invalid MCP scope");
    if (body.scope === "project" && !cwd) throw new Error("cwd required for project MCP settings");
    if (!Array.isArray(body.servers)) throw new Error("servers must be an array");
    const servers = body.servers.map(validateServer);
    if (new Set(servers.map(({ name }) => name)).size !== servers.length) throw new Error("MCP server names must be unique");

    const path = configPath(body.scope, cwd);
    const existing = readDocument(body.scope, cwd, roots);
    const restoredServers = servers.map(({ name, config }) => {
      const previous = existing.mcpServers?.[name];
      const unknown = previous ? Object.fromEntries(Object.entries(previous).filter(([key]) => !Object.hasOwn(SERVER_KEYS, key))) : {};
      return {
        name,
        config: { ...unknown, ...restoreRedactedValues(config, previous, name, previous ? redactConfig(previous) : undefined) as McpServerConfig },
      };
    });
    const document: McpDocument = {
      ...existing,
      $schema: existing.$schema ?? "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
      mcpServers: Object.fromEntries(restoredServers.map(({ name, config }) => [name, config])),
    };
    mkdirSync(dirname(path), { recursive: true });
    writePrivateFileAtomicSync(path, `${JSON.stringify(document, null, 2)}\n`);
    const updated = readScope(body.scope, cwd, roots);
    const user = body.scope === "user" ? updated : readScope("user", undefined, roots);
    applyEffectiveEnabledState({ user: user.scope, project: body.scope === "project" ? updated.scope : null }, user.document);
    return Response.json({ success: true, scope: updated.scope });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
