import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession, getFinalRpcSessionId, setRpcSessionTools } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { PromptCacheLossError, promptCacheLossBody } from "@/lib/prompt-cache";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (body.type === "set_tools") {
      const active = existing?.isAlive() ? existing : undefined;
      if (active || !id.startsWith("runtime:")) {
        const sessionFile = active ? active.sessionFile : await resolveSessionPath(id);
        if (!active && !sessionFile) return Response.json({ error: "Session not found" }, { status: 404 });
        const { session, sessionId } = await setRpcSessionTools(active?.sessionId ?? id, sessionFile ?? undefined, body.toolNames);
        return Response.json({ success: true, data: null, sessionId, runtimeId: session.runtimeId });
      }
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      existing.syncSessionIdentity();
      return Response.json({ success: true, data: result, sessionId: existing.sessionId, runtimeId: existing.runtimeId });
    }

    if (id.startsWith("runtime:")) {
      return Response.json({
        error: "Runtime session expired", code: "runtime_expired", accepted: false,
        sessionId: getFinalRpcSessionId(id),
      }, { status: 404 });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return Response.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined);
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    session.syncSessionIdentity();
    return Response.json({ success: true, data: result, sessionId: session.sessionId, runtimeId: session.runtimeId });
  } catch (error) {
    if (error instanceof PromptCacheLossError) return Response.json(promptCacheLossBody(error), { status: 409 });
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    let session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      const sessionId = getFinalRpcSessionId(id);
      session = sessionId ? getRpcSession(sessionId) : undefined;
      if (!session?.isAlive()) {
        return Response.json({ running: false, ...(sessionId ? { state: { sessionId } } : {}) });
      }
    }

    const state = await session.send({ type: "get_state" });
    // `?systemPrompt=0` drops the system prompt from the reply: status reads
    // (usage poll, stream connect, settle and reconcile) never show it, and it
    // is nearly all of the payload in a large project (#1302).
    if (new URL(req.url).searchParams.get("systemPrompt") === "0" && state && typeof state === "object") {
      const copy = { ...(state as Record<string, unknown>) };
      delete copy.systemPrompt;
      return Response.json({ running: true, state: copy });
    }
    return Response.json({ running: true, state });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
