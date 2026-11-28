import { parseConfiguredThinkingLevel as parseOmpThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking/levels";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/utils/render-utils";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";
import { isProjectOpeningId, RpcProjectTrustError } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
// omp owns the selector grammar (including abbreviations like "med"); reuse its
// parser so the browser and the CLI accept exactly the same values.
function parseThinkingLevel(value: unknown): ConfiguredThinkingLevel | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? parseOmpThinkingLevel(value) : undefined;
  if (parsed === undefined) throw new Error(`Invalid thinking level: ${String(value)}`);
  return parsed;
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return Response.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return Response.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames: requestedToolNames, thinkingLevel, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[] | null; thinkingLevel?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);
    // Omitted means omp's own loadout; an explicit list pins the session's tools.
    const toolNames = requestedToolNames ?? undefined;

    const header = req.headers.get("X-OMP-Project-Opening");
    const openingId = isProjectOpeningId(header) ? header : undefined;
    // Serialize starts sharing an opening until its grant is bound to the new transcript.
    const tempKey = `__new__${openingId ?? randomUUID()}`;
    const { session } = await startRpcSession(tempKey, "", cwd, {
      openingId,
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
    });

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);
    invalidateSessionListCache();

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
      configuredThinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return Response.json({
        success: true,
        sessionId: session.sessionId,
        runtimeId: session.runtimeId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
        configuredThinkingLevel: state.configuredThinkingLevel,
        toolNames: toolNames ?? null,
      });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    return Response.json({
      success: true,
      sessionId: session.sessionId,
      runtimeId: session.runtimeId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
      configuredThinkingLevel: state.configuredThinkingLevel,
    });
  } catch (error) {
    if (error instanceof RpcProjectTrustError) return Response.json({ error: error.message, accepted: false }, { status: error.status });
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}
