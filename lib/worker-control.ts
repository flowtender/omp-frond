import { request } from "node:http";
import { WORKER_CONTROL_HOST } from "@/worker/protocol";

export type WorkerState = "running" | "stopped" | "restarting";

export interface WorkerSummary {
  id: string;
  state: WorkerState;
  /** The launcher can restart it. A worker the operator supervises cannot be. */
  managed: boolean;
}

interface LauncherEndpoint {
  port: number;
  token: string;
}

export class LauncherRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LauncherRequestError";
  }
}

export function configuredLauncher(env = process.env): LauncherEndpoint | undefined {
  const { OMP_FROND_LAUNCHER_PORT: rawPort, OMP_FROND_LAUNCHER_TOKEN: token } = env;
  const port = Number(rawPort);
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { port, token };
}

async function callLauncher<T>(launcher: LauncherEndpoint, method: "GET" | "POST", path: string): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  // Connect directly (no `fetch`) so HTTP proxy settings cannot forward the launcher credential.
  const req = request({
    hostname: WORKER_CONTROL_HOST,
    port: launcher.port,
    method,
    path,
    headers: { Authorization: `Bearer ${launcher.token}` },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.once("error", reject);
    response.once("end", () => {
      const status = response.statusCode ?? 502;
      let body: { error?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { /* the status alone says what went wrong */ }
      if (status >= 200 && status < 300) resolve(body as T);
      else reject(new LauncherRequestError(body.error ?? `The launcher answered ${status}`, status));
    });
  });
  req.once("error", (error) => reject(new LauncherRequestError(error.message)));
  req.end();
  return promise;
}

/** The workers the launcher owns; empty when the worker is supervised elsewhere. */
export async function listLauncherWorkers(launcher: LauncherEndpoint): Promise<WorkerSummary[]> {
  const { workers } = await callLauncher<{ workers: Omit<WorkerSummary, "managed">[] }>(launcher, "GET", "/workers");
  return workers.map((worker) => ({ ...worker, managed: true }));
}

/** Stops the worker if it runs, starts it again on the same port, and resolves once it serves requests. */
export async function restartLauncherWorker(launcher: LauncherEndpoint, workerId: string): Promise<void> {
  await callLauncher(launcher, "POST", `/workers/${encodeURIComponent(workerId)}/restart`);
}
