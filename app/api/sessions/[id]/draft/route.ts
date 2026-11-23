import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  parseSharedSessionDraftRequest,
  type SessionDraftPollResponse,
  type SessionDraftSaveResponse,
} from "@/lib/session-draft-shared";
import { readSessionDraft, writeSessionDraft } from "@/lib/session-draft-store";
import { resolveSessionPath } from "@/lib/session-reader";
import { SESSION_ID_PATTERN } from "@/lib/session-ui-state-shared";

export const dynamic = "force-dynamic";

// The unsent composer draft of one saved session, shared by every device
// viewing it (lib/session-draft-sync.ts). GET with ?since=<revision> answers
// `unchanged` when nothing newer exists, so polling stays cheap even when the
// draft carries large images.

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// GET /api/sessions/[id]/draft[?since=<revision>]
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!SESSION_ID_PATTERN.test(id)) return refusal(400, "Invalid session id");
  try {
    if (!(await resolveSessionPath(id))) return refusal(404, "Session not found");
    const draft = readSessionDraft(id);
    const since = new URL(req.url).searchParams.get("since");
    const body: SessionDraftPollResponse = since !== null && Number(since) === draft.revision
      ? { revision: draft.revision, unchanged: true }
      : { revision: draft.revision, unchanged: false, value: draft.value, images: draft.images };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    return refusal(500, error instanceof Error ? error.message : String(error));
  }
}

// PUT /api/sessions/[id]/draft - replaces the draft; answers with the new revision only, images are not echoed back.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "Content-Type must be application/json");

  const { id } = await params;
  if (!SESSION_ID_PATTERN.test(id)) return refusal(400, "Invalid session id");
  if (!(await resolveSessionPath(id))) return refusal(404, "Session not found");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "Invalid JSON body");
  }
  const parsed = parseSharedSessionDraftRequest(body);
  if (!parsed.ok) return refusal(400, parsed.error);

  try {
    const saved: SessionDraftSaveResponse = { revision: writeSessionDraft(id, parsed.draft).revision };
    return NextResponse.json(saved, { headers: NO_STORE });
  } catch (error) {
    return refusal(500, error instanceof Error ? error.message : String(error));
  }
}
