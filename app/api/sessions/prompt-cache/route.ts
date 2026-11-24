import { NextResponse } from "next/server";
import { savedPromptCacheReports } from "@/lib/prompt-cache";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listAllSessions } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/sessions/prompt-cache - each listed session's prompt-cache status
// read off its transcript: { reports: { [id]: PromptCacheReport } }. Never
// starts an AgentSession; live sessions report through /api/agent/running.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  try {
    const sessions = await listAllSessions({ allowStale: true });
    const reports = await savedPromptCacheReports(sessions.filter((session) => !session.transient));
    return NextResponse.json({ reports }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers: NO_STORE });
  }
}
