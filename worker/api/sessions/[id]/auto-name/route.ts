import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession, getFinalRpcSessionId } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { RpcProjectTrustError } from "@/lib/project-trust";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let releasePolicyLease: (() => void) | undefined;

  try {
    const openingId = req.headers.get("X-OMP-Project-Opening") ?? undefined;
    let session = getRpcSession(id);
    const canonicalId = session?.isAlive() ? session.sessionId : id.startsWith("runtime:") ? getFinalRpcSessionId(id) : id;
    const filePath = session?.isAlive() ? session.sessionFile : canonicalId ? await resolveSessionPath(canonicalId) : undefined;
    if (!canonicalId || (!session?.isAlive() && !filePath)) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    ({ session } = await startRpcSession(canonicalId, filePath ?? "", session?.cwd, { openingId }));
    releasePolicyLease = session.acquireProjectPolicyLease();

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner);

    if (!session.isAlive()) {
      return Response.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    // omp declines to title greetings and other low-signal openers; report that
    // as a no-op instead of writing a meaningless name.
    if (!result) {
      return Response.json({ title: null, skipped: true });
    }

    await session.inner.sessionManager.setSessionName(result.title, "auto");
    invalidateSessionListCache();
    return Response.json({ title: result.title, sessionId: session.sessionId, runtimeId: session.runtimeId });
  } catch (error) {
    if (error instanceof RpcProjectTrustError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    releasePolicyLease?.();
  }
}
