import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession, type AgentEvent } from "@/lib/rpc-manager";
import { RpcProjectTrustError } from "@/lib/project-trust";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readLiveComposer } from "@/lib/session-composer";


const OMITTED_EVENT_TYPES = new Set(["turn_end", "tool_execution_update"]);

function toClientEvent(event: AgentEvent): AgentEvent | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  if (event.type === "message_update") {
    const clientEvent = { ...event };
    delete clientEvent.assistantMessageEvent;
    const message = event.message as AssistantMessage | undefined;
    if (message?.role === "assistant") {
      let content: AssistantMessage["content"] | undefined;
      for (let index = 0; index < message.content.length; index++) {
        const block = message.content[index];
        if (block.type !== "toolCall") continue;
        // The SDK's argument buffer is symbol-keyed and would vanish in SSE JSON.
        const rawInput = getStreamingPartialJson(block);
        if (rawInput === undefined) continue;
        content ??= message.content.slice();
        const projected = { ...block, rawInput };
        content[index] = projected;
      }
      if (content) clientEvent.message = { ...message, content };
    }
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

  const openingId = new URL(req.url).searchParams.get("openingId") ?? undefined;
  let session = getRpcSession(id);
  // An unauthorised observer may join an already-live stream, but must not
  // construct, reload, or replace a runtime.
  if (!openingId && !session?.isAlive()) return new Response("Project opening required", { status: 428 });
  const filePath = session?.isAlive() ? session.sessionFile : await resolveSessionPath(id);
  if (!session?.isAlive() && !filePath) return new Response("Session not found", { status: 404 });
  try {
    if (openingId) ({ session } = await startRpcSession(id, filePath ?? "", session?.cwd, { openingId }));
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Failed to start agent", {
      status: error instanceof RpcProjectTrustError ? error.status : 500,
    });
  }
  if (!session?.isAlive()) return new Response("Session unavailable", { status: 409 });

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

      // Read the run state and the open UI requests in the same synchronous step
      // as the subscription below, so the replay that follows matches this snapshot.
      // A client that was away uses pendingExtensionUiIds to drop requests that
      // were answered on another device.
      encode({
        type: "connected",
        sessionId: session.sessionId,
        runtimeId: session.runtimeId,
        isStreaming: session.isRunning(),
        pendingExtensionUiIds: session.pendingExtensionUiIds(),
        composer: readLiveComposer(session.inner),
      });

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
