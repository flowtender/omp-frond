import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpConfigFieldRef, McpConfigFileInfo, McpConfigFileProblemReason, McpServerInfo, ProjectExecutableResource, ProjectMcpListing } from "./api-types";
import { mcpConfigKey } from "./mcp-config-key";
import { maskArgs, maskCommand, maskUrl } from "./mcp-secrets";
import { isPathWithinRoots, resolveRealRoots } from "./path-security";
import { readRegularFileText, RegularFileReadError } from "./regular-file";

const MCP_PROJECT_MAX_BYTES = 1024 * 1024;
const MCP_PROJECT_MAX_SERVERS = 200;
const MAX_PREVIEW_FILES = 32;
const WEB_PASSWORD = "OMP_FROND_PASSWORD";

function mcpConfigObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function describeServer(name: string, value: unknown, sourcePath: string, userNames: ReadonlySet<string>): McpServerInfo {
  const entry = mcpConfigObject(value);
  const config = entry ?? {};
  const transport = config.type ?? config.transport;
  const isRemote = transport === "http" || transport === "sse" ||
    (transport == null && !config.command && Boolean(config.url));
  const command = !isRemote && typeof config.command === "string" ? maskCommand(config.command) : undefined;
  const args = !isRemote && Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string")
    ? maskArgs(config.args) : undefined;
  const url = isRemote && typeof config.url === "string" ? maskUrl(config.url) : undefined;
  const env = (!isRemote && mcpConfigObject(config.env)) || {};
  const headers = (isRemote && mcpConfigObject(config.headers)) || {};
  const commandFields: McpServerInfo["commandFields"] = [];
  const variableReferences: McpServerInfo["variableReferences"] = [];

  // OMP expands ${VAR} during discovery, then tries a bare env name or !command
  // for the active transport's env or headers. Describe those inputs without
  // reading the host's environment or invoking SDK discovery.
  let webPasswordField: McpConfigFieldRef | undefined;
  const describeValue = (field: McpConfigFieldRef, raw: unknown) => {
    if (typeof raw !== "string") return;
    const variables = new Set(Array.from(raw.matchAll(/\$\{([^}:]+)(?::-[^}]*)?\}/g), (match) => match[1]));
    if (/^[A-Za-z_]\w*$/.test(raw)) variables.add(raw);
    if (variables.has(WEB_PASSWORD) || /\$OMP_FROND_PASSWORD\b/.test(raw)) webPasswordField ??= field;
    if (raw.startsWith("!")) commandFields.push(field);
    else if (variables.size > 0) variableReferences.push({ ...field, variables: [...variables] });
  };
  for (const [fieldName, raw] of Object.entries(isRemote ? headers : env)) {
    describeValue({ kind: isRemote ? "header" : "env", name: fieldName }, raw);
  }
  if (isRemote) {
    const field = { kind: "oauth-client-secret" } as const;
    describeValue(field, mcpConfigObject(config.oauth)?.clientSecret);
    describeValue(field, mcpConfigObject(config.auth)?.clientSecret);
  }
  const enabled = typeof config.enabled === "string" ? config.enabled.toLowerCase() : config.enabled;
  const headerNames = Object.keys(headers);

  return {
    name,
    scope: "project",
    sourcePath,
    configKey: mcpConfigKey(value),
    enabled: enabled !== false && enabled !== "false" && enabled !== "0",
    validated: false,
    ...(entry ? { transport: isRemote ? "http" : "stdio" } : { notAnObject: true }),
    ...(command && { command: command.value }),
    ...(args && { args: args.args }),
    ...(url && { url: url.value }),
    ...(!isRemote && typeof config.cwd === "string" && { cwd: config.cwd }),
    envNames: Object.keys(env),
    headerNames,
    usesOAuth: isRemote && !config.auth && !headerNames.some((header) => header.toLowerCase() === "authorization"),
    commandFields,
    variableReferences,
    ...(webPasswordField && { webPasswordField }),
    ...((command || url) && userNames.has(name) && { replacesGlobal: true }),
    masked: Boolean(command?.masked || args?.masked || url?.masked),
  };
}

function readServerMap(
  file: McpConfigFileInfo,
  options: { allowedRoots?: Set<string>; inventoried?: boolean; serverBudget?: number } = {},
): Record<string, unknown> | undefined {
  const { path } = file;
  function problem(reason: McpConfigFileProblemReason, error: string): undefined {
    file.problems.push({ reason, error });
    return undefined;
  }

  let realPath: string;
  let text: string | undefined;
  try {
    try {
      realPath = realpathSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") return problem("not-a-file", "The MCP config path is not a regular file.");
      if (code !== "ENOENT") throw error;
      const dir = dirname(path);
      return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ||
        (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(dir))
        ? problem("link-dangling", "The MCP config link has no target.") : undefined;
    }
    file.exists = true;
    if (options.allowedRoots && !isPathWithinRoots(realPath, options.allowedRoots)) {
      return problem("link-outside", "The MCP config target is outside the allowed folders.");
    }
    if (realPath !== path) file.realPath = realPath;
    text = readRegularFileText(realPath, MCP_PROJECT_MAX_BYTES, { noFollow: true });
    if (text === undefined) return problem("unreadable", "The MCP config changed while it was being read.");
  } catch (error) {
    return error instanceof RegularFileReadError
      ? problem(error.reason, error.message)
      : problem("unreadable", "Could not read the MCP config.");
  }

  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return problem("unparsable", "The MCP config is not valid JSON.");
  }
  const document = mcpConfigObject(config);
  if (!document) return problem("invalid-shape", "Expected an MCP configuration object.");
  const nested = mcpConfigObject(document.mcp);
  const rawServers = Object.hasOwn(document, "mcpServers") ? document.mcpServers
    : nested && Object.hasOwn(nested, "servers") ? nested.servers : document.servers;
  if (rawServers === undefined) {
    return options.inventoried ? problem("unsupported-preview", "No supported server map could be previewed.") : undefined;
  }
  const servers = mcpConfigObject(rawServers);
  if (!servers) return problem("invalid-shape", "Expected an MCP server map.");
  if (Object.keys(servers).length > (options.serverBudget ?? MCP_PROJECT_MAX_SERVERS)) {
    return problem("too-many-servers", "The MCP preview's server limit was reached.");
  }
  return servers;
}

function readUserServerNames(agentDir: string): Set<string> {
  const names = new Set<string>();
  for (const filename of ["mcp.json", ".mcp.json"]) {
    const file: McpConfigFileInfo = { scope: "global", path: join(agentDir, filename), exists: false, problems: [] };
    const servers = readServerMap(file);
    if (servers) {
      for (const [name, value] of Object.entries(servers)) {
        const config = mcpConfigObject(value);
        if (typeof config?.command === "string" || typeof config?.url === "string") names.add(name);
      }
    }
  }
  return names;
}

/** Inspect only inventoried files and the primary project file; never resolve values. */
export function readProjectMcpListing(
  cwd: string,
  checkoutRoot: string,
  resources: readonly ProjectExecutableResource[],
  allowedRoots: Set<string>,
  agentDir: string,
): ProjectMcpListing {
  const primary = join(cwd, ".omp", "mcp.json");
  const scopes = resolveRealRoots(allowedRoots);
  const paths = new Set([primary]);
  for (const resource of resources) {
    if (resource.kind === "mcp") paths.add(join(checkoutRoot, resource.path));
  }
  let userNames: Set<string> | undefined;
  const mcpFiles: McpConfigFileInfo[] = [];
  const mcpServers: McpServerInfo[] = [];
  for (const path of paths) {
    const file: McpConfigFileInfo = { scope: "project", path, exists: false, problems: [] };
    if (mcpFiles.length >= MAX_PREVIEW_FILES) {
      file.problems.push({ reason: "unsupported-preview", error: "The MCP preview's file limit was reached." });
    } else {
      const servers = readServerMap(file, {
        allowedRoots: scopes,
        inventoried: path !== primary,
        serverBudget: MCP_PROJECT_MAX_SERVERS - mcpServers.length,
      });
      if (servers) {
        for (const [name, value] of Object.entries(servers)) {
          userNames ??= readUserServerNames(agentDir);
          mcpServers.push(describeServer(name, value, path, userNames));
        }
      }
    }
    mcpFiles.push(file);
  }
  return { mcpFile: mcpFiles[0], mcpFiles, mcpServers };
}
