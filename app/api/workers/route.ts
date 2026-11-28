import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { configuredWorker } from "@/lib/worker-client";
import { configuredLauncher, listLauncherWorkers, type WorkerSummary } from "@/lib/worker-control";

export const dynamic = "force-dynamic";

// GET /api/workers - The workers new conversations can start on. A worker the
// launcher did not start (one the operator supervises) is listed but cannot
// be restarted from here.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const launcher = configuredLauncher();
  let workers: WorkerSummary[] = [];
  if (launcher) {
    try {
      workers = await listLauncherWorkers(launcher);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
    }
  } else {
    const external = configuredWorker();
    if (external) workers = [{ id: external.workerId, state: "running", managed: false }];
  }
  return NextResponse.json({ workers }, { headers: { "Cache-Control": "no-store" } });
}
