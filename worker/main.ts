import { timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import lockfile from "proper-lockfile";
import { shutdownWorkerSessions } from "@/lib/rpc-manager";
import { workerWorkspaceRoot } from "@/lib/worker-workspace";
import { handleWorkerApi } from "./api";
import { WORKER_CONTROL_HOST, WORKER_ID_HEADER } from "./protocol";

const { OMP_FROND_WORKER_ID: workerId, OMP_FROND_WORKER_TOKEN: token,
  OMP_FROND_WORKER_PORT: configuredPort = "0", PI_CODING_AGENT_DIR: agentDir } = process.env;

if (!workerId || !/^[\w-]{1,64}$/.test(workerId)) {
  throw new Error("OMP_FROND_WORKER_ID must be a stable identifier (letters, digits, _ or -).");
}
if (!token || !/^[0-9a-f]{64}$/.test(token)) {
  throw new Error("OMP_FROND_WORKER_TOKEN must be a 32-byte lowercase hex secret.");
}
if (process.env.OMP_FROND_LOCAL_WORKER !== "1" && (!agentDir || !isAbsolute(agentDir))) {
  throw new Error("PI_CODING_AGENT_DIR must name an explicit absolute agent directory.");
}
const bindHost = process.env.OMP_FROND_WORKER_BIND_HOST ?? WORKER_CONTROL_HOST;
if (bindHost !== WORKER_CONTROL_HOST && (bindHost !== "0.0.0.0" || !workerWorkspaceRoot)) {
  throw new Error("A non-loopback worker listener requires an explicit restricted workspace.");
}
const port = Number(configuredPort);
if (!/^\d+$/.test(configuredPort) || port > 65535) {
  throw new Error("OMP_FROND_WORKER_PORT must be a TCP port (or 0 for an ephemeral port).");
}

const expectedAuthorization = Buffer.from(`Bearer ${token}`);
delete process.env.OMP_FROND_WORKER_TOKEN;

const sessionHome = getAgentDir();
await mkdir(sessionHome, { recursive: true });
const releaseOwnership = await lockfile.lock(sessionHome, {
  lockfilePath: join(sessionHome, "omp-frond-worker.lock"),
}).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ELOCKED") throw error;
  throw new Error("Another frond SDK worker already owns this agent home.", { cause: error });
});

const server = Bun.serve({
  hostname: bindHost,
  port,
  idleTimeout: 0,
  async fetch(req) {
    const authorization = Buffer.from(req.headers.get("authorization") ?? "");
    if (authorization.length !== expectedAuthorization.length
      || !timingSafeEqual(authorization, expectedAuthorization)) {
      return Response.json({ error: "Worker authentication required" }, { status: 401 });
    }
    if (req.headers.get(WORKER_ID_HEADER) !== workerId) {
      return Response.json({ error: "Worker identity mismatch" }, { status: 409 });
    }

    let response: Response;
    try {
      response = await handleWorkerApi(req);
    } catch (error) {
      console.error("[omp-frond worker] failed to handle request:", error);
      response = Response.json({ error: "Worker operation failed" }, { status: 500 });
    }
    response.headers.set(WORKER_ID_HEADER, workerId);
    return response;
  },
});

console.log(JSON.stringify({ workerId, port: server.port }));

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void server.stop(true);
  const deadline = setTimeout(() => process.exit(1), 6_000);
  void shutdownWorkerSessions().then(() => releaseOwnership()).then(() => {
    clearTimeout(deadline);
    process.exit(0);
  }).catch((error) => {
    console.error("[omp-frond worker] shutdown failed:", error);
    process.exit(1);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
