import { isBashToolName } from "./tool-names";
import { mcpToolLabel } from "./mcp-tool-display";
import type { TranslationParams } from "./i18n/types";

const MAX_IMPACT_TEXT = 200_000;

export interface ToolDispatch {
  tool: string;
  mode: "help" | "execute";
  exitCode: number;
  args?: Record<string, unknown>;
  inner?: unknown;
}

function isToolDispatch(value: unknown): value is ToolDispatch {
  return typeof value === "object" && value !== null && "tool" in value && typeof value.tool === "string"
    && value.tool.length > 0 && "mode" in value && (value.mode === "help" || value.mode === "execute")
    && "exitCode" in value && typeof value.exitCode === "number" && Number.isInteger(value.exitCode)
    && (!("args" in value) || value.args === undefined
      || (value.args !== null && typeof value.args === "object" && !Array.isArray(value.args)));
}

const NO_DISPATCHES: readonly ToolDispatch[] = [];

export function shellToolDispatches(details: unknown): readonly ToolDispatch[] {
  return typeof details === "object" && details !== null && "toolCommands" in details && Array.isArray(details.toolCommands)
    ? details.toolCommands.filter(isToolDispatch)
    : NO_DISPATCHES;
}

/** The tools a call actually ran: a bash call that dispatched tool commands (`lsp …`) ran those, not bash. */
export function ranToolNames(toolName: string, details: unknown): readonly string[] {
  if (!isBashToolName(toolName)) return [toolName];
  const dispatches = shellToolDispatches(details);
  return dispatches.length > 0 ? dispatches.map(({ tool }) => tool) : [toolName];
}

function brief(value: unknown): string {
  return typeof value === "string" ? value.trim().split(/\r?\n/, 1)[0].slice(0, 120) : "";
}

export function inlineToolTarget(tool: string, args?: Record<string, unknown>): string {
  if (!args) return "";
  switch (tool) {
    case "memory_edit": return [brief(args.op), brief(args.id)].filter(Boolean).join(" · ");
    case "reflect": return brief(args.query);
    case "retain": return "";
    default:
      return brief(args.target) || brief(args.query) || brief(args.path) || brief(args.symbol);
  }
}

export function inlineToolResult(tool: string, details: unknown, translate: (key: string, params?: TranslationParams) => string): string {
  if (typeof details !== "object" || details === null) return "";
  switch (tool) {
    case "lsp": return "serverName" in details ? brief(details.serverName) : "";
    case "memory_edit": return "status" in details ? brief(details.status) : "";
    case "retain": return "count" in details && typeof details.count === "number"
      ? translate("chat.toolMemoriesStored", { count: details.count }) : "";
  }
  const mcp = mcpToolLabel(tool, details);
  if (mcp?.server !== "gitnexus" || mcp.tool !== "impact") return "";
  let impact: unknown = "structuredContent" in details ? details.structuredContent : undefined;
  // GitNexus can return JSON as a text block with a next-step hint appended.
  if (impact === undefined && "rawContent" in details && Array.isArray(details.rawContent) && details.rawContent.length === 1) {
    const block = details.rawContent[0];
    if (block?.type === "text" && typeof block.text === "string" && block.text.length <= MAX_IMPACT_TEXT) {
      const hint = block.text.indexOf("\n\n---\n**Next:**");
      try {
        impact = JSON.parse(hint < 0 ? block.text : block.text.slice(0, hint));
      } catch {
        return "";
      }
    }
  }
  if (typeof impact !== "object" || impact === null || !("risk" in impact)
    || typeof impact.risk !== "string" || !/^(LOW|MEDIUM|HIGH|CRITICAL|UNKNOWN)$/.test(impact.risk)) return "";
  const target = "target" in impact && impact.target && typeof impact.target === "object" && "name" in impact.target
    ? brief(impact.target.name) : "";
  const direct = "summary" in impact && impact.summary && typeof impact.summary === "object" && "direct" in impact.summary
    ? impact.summary.direct : undefined;
  const lowerBound = "epistemic" in impact && impact.epistemic === "lower-bound";
  return [target, translate("chat.toolImpactRisk", { risk: impact.risk }), typeof direct === "number"
    ? translate("chat.toolImpactDirect", { count: lowerBound ? `≥${direct}` : direct }) : ""].filter(Boolean).join(" · ");
}
