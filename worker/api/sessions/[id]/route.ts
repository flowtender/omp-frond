import { existsSync, statSync, unlinkSync } from "fs";
import { dirname } from "path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  buildSessionContext,
  getHistoricalContextUsage,
  readSessionHeader,
  CONTEXT_DEFAULT_TAIL,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { childrenToReparent, reparentSessionFile } from "@/lib/session-reparent";
import { setSessionArchived } from "@/lib/session-archive";
import { forgetSessionDrafts } from "@/lib/session-draft-store";
import { getRpcSession, renameRpcSession } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { getOmpRuntime, getSettingsForCwd } from "@/lib/omp-runtime";
import { readLiveComposer, readRestoredComposer } from "@/lib/session-composer";
import type { SessionEntry } from "@/lib/types";
import { getWebSessionAccent } from "@/lib/omp-theme";
import { livePromptCacheReport, savedSessionPromptCacheReport } from "@/lib/prompt-cache";
import { attachTranscriptNotices, findTranscriptNotices } from "@/lib/entry-notices";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? await SessionManager.open(resolvedPath!);
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries() as unknown as SessionEntry[];
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    // Bounded like /context: an initial open must never serialize the whole
    // branch (mobile OOM); the client pages upward from `oldestEntryId`.
    const rawTail = Number(searchParams.get("tail"));
    const tail = Math.min(Number.isFinite(rawTail) && rawTail > 0 ? rawTail : CONTEXT_DEFAULT_TAIL, 1000);
    const context = attachTranscriptNotices(
      buildSessionContext(entries, leafId, { deferThinking, deferToolResultImages, tail }),
      findTranscriptNotices(entries, leafId),
    );
    const settings = liveRpc?.inner.settings ?? await getSettingsForCwd(sm.getCwd());
    const composer = liveRpc
      ? readLiveComposer(liveRpc.inner)
      : await readRestoredComposer(context, entries, settings, (await getOmpRuntime()).modelRegistry);
    const [contextUsage, sessionAccent, promptCache] = await Promise.all([
      getHistoricalContextUsage(entries, leafId),
      composer.shimmer === "classic" ? getWebSessionAccent(sm.getSessionName(), settings) : undefined,
      liveRpc ? livePromptCacheReport(liveRpc.inner) : savedSessionPromptCacheReport(sm, settings),
    ]);
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sm.getSessionName(),
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      transient: !filePath || !existsSync(filePath),
    } : null;

    return Response.json({
      sessionId: liveRpc?.sessionId ?? sm.getSessionId(),
      runtimeId: liveRpc?.runtimeId,
      filePath,
      info,
      leafId,
      tree,
      context: { ...context, ...composer },
      sessionAccent,
      totalActiveMs,
      ...(contextUsage ? { contextUsage } : {}),
      promptCache,
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
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
  try {
    const { name, archived } = await req.json() as { name?: string; archived?: boolean };
    const hasName = typeof name === "string";
    const hasArchived = typeof archived === "boolean";
    if (!hasName && !hasArchived) {
      return Response.json({ error: "name or archived is required" }, { status: 400 });
    }
    const owner = getRpcSession(id);
    const filePath = owner?.isAlive() ? owner.sessionFile ?? null : await resolveSessionPath(id);
    if (!filePath && !owner?.isAlive()) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    const canonicalId = owner?.sessionId ?? (filePath && readSessionHeader(filePath)?.id) ?? id;
    if (hasName) {
      const title = name.trim();
      if (!title) return Response.json({ error: "Session name cannot be empty" }, { status: 400 });
      if (!await renameRpcSession(canonicalId, filePath, title)) {
        return Response.json({ error: "Session could not be renamed. Try again." }, { status: 409 });
      }
      if (filePath) invalidateSessionManagerCache(filePath);
    }
    if (hasArchived) {
      // Key the registry by the header id (what /api/sessions lists), not by
      // whatever alias the client addressed the session with.
      setSessionArchived(canonicalId, archived);
    }
    invalidateSessionListCache();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Read only the bounded header before deleting.
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;

    // Re-attach direct children before removing their parent.
    const targetPathKey = sessionPathKey(filePath);
    for (const child of childrenToReparent(dirname(filePath), (key) => key === targetPathKey)) {
      reparentSessionFile(child.path, parentSessionPath);
    }

    await getRpcSession(id)?.shutdown();
    unlinkSync(filePath);
    // The unsent draft goes with the session; the file is already gone, so a failure here only logs.
    try {
      forgetSessionDrafts([id]);
    } catch (error) {
      console.warn(`[omp-frond] could not clear the unsent draft of ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
