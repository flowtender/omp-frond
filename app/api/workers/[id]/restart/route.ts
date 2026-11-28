import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { configuredWorker, requestWorker, WorkerUnavailableError } from "@/lib/worker-client";
import { configuredLauncher, LauncherRequestError, restartLauncherWorker } from "@/lib/worker-control";

export const dynamic = "force-dynamic";

/** Sessions of the worker that are mid-run; a stopped worker has none. */
async function countRunningSessions(req: Request): Promise<number> {
  const worker = configuredWorker();
  if (!worker) return 0;
  try {
    const host = req.headers.get("host");
    const response = await requestWorker(worker, new Request(new URL("/api/agent/running", req.url), {
      headers: host ? { host } : {},
      signal: req.signal,
    }));
    if (!response.ok) return 0;
    const { runningSessionIds } = await response.json() as { runningSessionIds?: string[] };
    return runningSessionIds?.length ?? 0;
  } catch (error) {
    if (error instanceof WorkerUnavailableError) return 0;
    throw error;
  }
}

// POST /api/workers/[id]/restart { force?: boolean } - Stops the worker (if it
// runs) and starts it again, so changed tools or a rebuilt worker take effect.
// A worker in the middle of a run answers 409 { busy: true, runningSessions }
// until the caller repeats the request with `force`.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const launcher = configuredLauncher();
  if (!launcher) {
    return NextResponse.json({ error: "This worker is not managed by the launcher" }, { status: 409 });
  }

  const { id } = await params;
  let force = false;
  try {
    force = (await req.json() as { force?: unknown }).force === true;
  } catch { /* no body: not forced */ }

  if (!force) {
    const runningSessions = await countRunningSessions(req);
    if (runningSessions > 0) return NextResponse.json({ busy: true, runningSessions }, { status: 409 });
  }

  try {
    await restartLauncherWorker(launcher, id);
  } catch (error) {
    const status = error instanceof LauncherRequestError && error.status === 404 ? 404 : 502;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
  return NextResponse.json({ ok: true });
}
