import { Agent, request, type IncomingMessage } from "node:http";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { WORKER_BROWSER_HOST_HEADER, WORKER_CONTROL_HOST, WORKER_ID_HEADER } from "@/worker/protocol";

export interface WorkerEndpoint {
  workerId: string;
  hostname?: string;
  port: number;
  token: string;
}

export class WorkerUnavailableError extends Error {
  constructor(workerId: string, cause: unknown) {
    super(`Worker ${workerId} is unavailable`, { cause });
    this.name = "WorkerUnavailableError";
  }
}

// Connect directly so HTTP proxy settings cannot forward the worker credential.
const agent = new Agent({ keepAlive: true });

const REQUEST_HEADERS = ["content-type", "content-length", "range", "last-event-id"] as const;
const PRIVATE_RESPONSE_HEADERS = [
  WORKER_ID_HEADER, "connection", "keep-alive", "transfer-encoding", "upgrade", "set-cookie",
] as const;

export function configuredWorker(env = process.env): WorkerEndpoint | undefined {
  const {
    OMP_FROND_WORKER_ID: workerId, OMP_FROND_WORKER_PORT: rawPort,
    OMP_FROND_WORKER_TOKEN: token, OMP_FROND_WORKER_HOST: hostname,
  } = env;
  const port = Number(rawPort);
  if (!workerId || !token || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { workerId, port, token, hostname };
}

export async function requestWorker(worker: WorkerEndpoint, incoming: Request): Promise<Response> {
  const { pathname, search } = new URL(incoming.url);
  const headers: Record<string, string> = {
    Host: WORKER_CONTROL_HOST,
    Authorization: `Bearer ${worker.token}`,
    [WORKER_ID_HEADER]: worker.workerId,
  };
  const browserHost = incoming.headers.get("host");
  if (browserHost) headers[WORKER_BROWSER_HOST_HEADER] = browserHost;
  for (const name of REQUEST_HEADERS) {
    const value = incoming.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  try {
    const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
    const req = request({
      agent,
      hostname: worker.hostname ?? WORKER_CONTROL_HOST,
      port: worker.port,
      method: incoming.method,
      path: pathname + search,
      signal: incoming.signal,
      headers,
    }, resolve);
    req.once("error", reject);
    // Node and DOM declare different types for the same Web Streams at runtime.
    if (incoming.body) {
      pipeline(Readable.fromWeb(incoming.body as unknown as NodeReadableStream), req, (error) => {
        if (error) reject(error);
      });
    } else {
      req.end();
    }
    const response = await promise;
    const status = response.statusCode ?? 502;
    if (response.headers[WORKER_ID_HEADER] !== worker.workerId) {
      response.destroy();
      throw new Error(`Unexpected control response: ${status}`);
    }

    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if ((PRIVATE_RESPONSE_HEADERS as readonly string[]).includes(name)) continue;
      if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
      else if (value !== undefined) responseHeaders.set(name, value);
    }
    if (incoming.method === "HEAD" || status === 204 || status === 205 || status === 304) {
      response.resume();
      return new Response(null, { status, headers: responseHeaders });
    }
    return new Response(Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, { status, headers: responseHeaders });
  } catch (error) {
    incoming.signal.throwIfAborted();
    throw new WorkerUnavailableError(worker.workerId, error);
  }
}
