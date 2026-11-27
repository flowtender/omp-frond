import { configuredWorker, requestWorker, WorkerUnavailableError } from "@/lib/worker-client";
import { isApiRequestAllowed } from "@/lib/request-security";
import { WORKER_UNAVAILABLE_CODE, WORKER_UNAVAILABLE_MESSAGE } from "@/worker/protocol";

export const dynamic = "force-dynamic";

function workerUnavailable() {
  return Response.json({ code: WORKER_UNAVAILABLE_CODE, error: WORKER_UNAVAILABLE_MESSAGE }, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

async function relay(req: Request): Promise<Response> {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const worker = configuredWorker();
  if (!worker) return workerUnavailable();
  try {
    return await requestWorker(worker, req);
  } catch (error) {
    if (error instanceof WorkerUnavailableError) return workerUnavailable();
    throw error;
  }
}

export { relay as GET, relay as HEAD, relay as POST, relay as PUT, relay as PATCH, relay as DELETE, relay as OPTIONS };
