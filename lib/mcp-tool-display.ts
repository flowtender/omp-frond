// Display names for MCP tools. pi registers them as `mcp__<server>__<tool>`,
// sanitized to `[A-Za-z0-9_-]` and given a hash suffix past 64 characters or
// when another tool already has the name, so the registered name cannot be
// split back into the server's names: `docs.v2` / `search.pages` and
// `docs_v2` / `search_pages` sanitize alike, and either part may hold `__`. pi's TUI labels them `server/tool` from the tool
// definition; the browser has those names only in a result's details
// (legacy `{ server, tool }` or the SDK bridge's `{ serverName, mcpToolName }`).
// Without a result a call keeps its registered name.

const MCP_TOOL_PREFIX = "mcp__";

export interface McpToolLabel {
  server: string;
  tool: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The server and tool an MCP call's result names, or null when there is none to go by. */
export function mcpToolLabel(toolName: string, details?: unknown): McpToolLabel | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX) || !isRecord(details)) return null;
  for (const [server, tool] of [[details.serverName, details.mcpToolName], [details.server, details.tool]]) {
    if (typeof server === "string" && typeof tool === "string" && server && tool) return { server, tool };
  }
  return null;
}
