import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession, type AgentEvent } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const OMITTED_EVENT_TYPES = new Set(["turn_start", "turn_end", "tool_execution_update"]);

function toClientEvent(event: AgentEvent): AgentEvent | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  if (event.type === "message_update") {
    const clientEvent = { ...event };
    delete clientEvent.assistantMessageEvent;
    return clientEvent;
  }
  if (event.type === "agent_end") return { type: "agent_end" };
  return event;
}

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) {
    return new Response("Untrusted API request", { status: 403 });
  }


  // Fast path: already-running session
  let session = getRpcSession(id);
  if (!session || !session.isAlive()) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    try {
      ({ session } = await startRpcSession(id, filePath, undefined));
    } catch {
      return new Response("Failed to start agent", { status: 500 });
    }
  }

  let cancelStream = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const cleanup = (closeController: boolean) => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        req.signal.removeEventListener("abort", onAbort);
        if (closeController) controller.close();
      };
      const onAbort = () => cleanup(true);
      cancelStream = () => cleanup(false);
      req.signal.addEventListener("abort", onAbort, { once: true });
      // The client can disconnect while startRpcSession is still pending.
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }

      const encode = (data: unknown) => {
        if (closed) return;
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      // Send initial connected event
      encode({ type: "connected", sessionId: session.sessionId, runtimeId: session.runtimeId });

      unsubscribe = session.onEvent((event) => {
        const clientEvent = toClientEvent(event);
        if (clientEvent) encode(clientEvent);
      });
      if (closed) {
        unsubscribe();
        return;
      }

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

    },
    cancel() {
      cancelStream();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
