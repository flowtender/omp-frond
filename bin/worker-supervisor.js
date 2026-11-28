"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require("node:child_process");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
/* eslint-enable @typescript-eslint/no-require-imports */

const WORKER_STOP_MS = 7_000;
const CONTROL_HOST = "127.0.0.1";
const LOCAL_WORKER_ID = "local";

function isAlive(child) {
  return Boolean(child?.pid) && child.exitCode === null && child.signalCode === null;
}

// Next's graceful close waits for open SSE streams, so a polite signal alone can hang forever.
function terminate(child, signal = "SIGTERM") {
  if (!isAlive(child)) return;
  child.kill(signal);
  const deadline = setTimeout(() => child.kill("SIGKILL"), WORKER_STOP_MS);
  child.once("exit", () => clearTimeout(deadline));
}

function stopWorker(child) {
  if (child?.killed) return;
  terminate(child);
}

async function stopAndWait(child) {
  if (!isAlive(child)) return;
  const exited = once(child, "exit");
  terminate(child);
  await exited;
}

/** True for a worker the operator supervises; the launcher then neither starts nor restarts it. */
function isExternalWorker(env) {
  const { OMP_FROND_WORKER_ID: workerId, OMP_FROND_WORKER_PORT: port, OMP_FROND_WORKER_TOKEN: token } = env;
  if (!workerId && !port && !token && !env.OMP_FROND_WORKER_HOST) return false;
  if (!workerId || !/^[\w-]{1,64}$/.test(workerId) || !/^\d+$/.test(port ?? "")
    || Number(port) < 1 || Number(port) > 65535 || !/^[0-9a-f]{64}$/.test(token ?? "")) {
    throw new Error("An external worker requires OMP_FROND_WORKER_ID, OMP_FROND_WORKER_PORT, and OMP_FROND_WORKER_TOKEN.");
  }
  return true;
}

/**
 * Starts the local worker. A restart passes the previous `port` and `token`
 * back in: the web server received them in its environment and cannot be told
 * new ones.
 */
async function spawnLocalWorker(bunPath, cwd, env, { port = 0, token = randomBytes(32).toString("hex") } = {}) {
  const workerEnv = {
    ...env,
    OMP_FROND_LOCAL_WORKER: "1",
    OMP_FROND_WORKER_ID: LOCAL_WORKER_ID,
    OMP_FROND_WORKER_PORT: String(port),
    OMP_FROND_WORKER_TOKEN: token,
  };
  for (const key of ["OMP_FROND_PASSWORD", "OMP_FROND_AUTH_FILE", "OMP_FROND_TLS_CERT", "OMP_FROND_TLS_KEY"]) {
    delete workerEnv[key];
  }
  const child = spawn(bunPath, ["--no-env-file", join(cwd, "worker", "main.ts")], {
    cwd,
    env: workerEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const { promise, resolve, reject } = Promise.withResolvers();
  child.on("error", reject);
  child.once("exit", (code, signal) => reject(new Error(`SDK worker exited before startup (${signal ?? code}).`)));
  const lines = createInterface({ input: child.stdout });
  let ready = false;
  lines.on("line", (line) => {
    if (!ready && line.startsWith("{")) {
      try {
        const message = JSON.parse(line);
        if (message.workerId === LOCAL_WORKER_ID && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
          ready = true;
          resolve(message.port);
          return;
        }
      } catch { /* not the worker readiness record */ }
    }
    process.stderr.write(`${line}\n`);
  });
  const deadline = setTimeout(() => reject(new Error("The SDK worker did not report its private control port.")), 15_000);
  try {
    return { child, port: await promise, token };
  } catch (error) {
    stopWorker(child);
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

/**
 * The web server's way to the launcher: list the workers it owns and restart
 * one. Loopback only, behind a bearer token that only the web server's
 * environment carries (never the worker's).
 */
async function startControlServer({ describe, restart }) {
  const token = randomBytes(32).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const server = createServer((request, response) => {
    request.resume();
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
      sendJson(response, 401, { error: "Launcher authentication required" });
      return;
    }
    const { pathname } = new URL(request.url ?? "/", `http://${CONTROL_HOST}`);
    if (request.method === "GET" && pathname === "/workers") {
      sendJson(response, 200, { workers: describe() });
      return;
    }
    const restartMatch = /^\/workers\/([\w-]{1,64})\/restart$/.exec(pathname);
    if (request.method === "POST" && restartMatch) {
      if (restartMatch[1] !== LOCAL_WORKER_ID) {
        sendJson(response, 404, { error: "Unknown worker" });
        return;
      }
      restart().then(
        () => sendJson(response, 200, { workers: describe() }),
        (error) => sendJson(response, 500, { error: error.message, workers: describe() }),
      );
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  });
  server.listen(0, CONTROL_HOST);
  await once(server, "listening");
  return {
    port: server.address().port,
    token,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function superviseWeb({ bunPath, cwd, env, nextArgs, onWebOutput }) {
  const local = { child: null, port: 0, token: undefined, state: "stopped", restarting: null };
  let control = null;
  let web = null;
  let stopSignal;
  let restart = false;
  const stop = (signal) => {
    if (stopSignal) {
      if (isAlive(web)) web.kill("SIGKILL");
      if (isAlive(local.child)) local.child.kill("SIGKILL");
      return;
    }
    stopSignal = signal;
    if (web) terminate(web, signal);
    stopWorker(local.child);
  };
  const restartWeb = () => {
    if (stopSignal || !web) return;
    restart = true;
    terminate(web);
  };
  const launchLocalWorker = async () => {
    const started = await spawnLocalWorker(bunPath, cwd, env, { port: local.port, token: local.token });
    Object.assign(local, { ...started, state: "running" });
    started.child.once("exit", (code, signal) => {
      if (local.child !== started.child) return;
      local.state = "stopped";
      if (!stopSignal && web && !local.restarting) console.error(`SDK worker stopped (${signal ?? code}); the web server is still running.`);
    });
    if (stopSignal) stopWorker(started.child);
  };
  // Concurrent requests share one restart. The new worker waits for the old
  // one's exit: it releases the agent home's lock on its way out.
  const restartLocalWorker = () => local.restarting ??= (async () => {
    try {
      await stopAndWait(local.child);
      if (stopSignal) throw new Error("The launcher is stopping.");
      await launchLocalWorker();
    } finally {
      local.restarting = null;
    }
  })();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (process.platform !== "win32") process.on("SIGHUP", restartWeb);
  try {
    let webEnv = env;
    if (!isExternalWorker(env)) {
      await launchLocalWorker();
      control = await startControlServer({
        describe: () => [{ id: LOCAL_WORKER_ID, state: local.restarting ? "restarting" : local.state }],
        restart: restartLocalWorker,
      });
      webEnv = {
        ...env,
        OMP_FROND_WORKER_ID: LOCAL_WORKER_ID,
        OMP_FROND_WORKER_PORT: String(local.port),
        OMP_FROND_WORKER_TOKEN: local.token,
        OMP_FROND_LAUNCHER_PORT: String(control.port),
        OMP_FROND_LAUNCHER_TOKEN: control.token,
      };
    }

    while (!stopSignal) {
      restart = false;
      web = spawn(bunPath, nextArgs, { cwd, env: webEnv, stdio: ["inherit", "pipe", "inherit"] });
      web.stdout.on("data", onWebOutput ?? ((chunk) => process.stdout.write(chunk)));
      const [code, signal] = await once(web, "exit");
      if (!restart && !stopSignal) return code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
    }
    return stopSignal === "SIGINT" ? 130 : 143;
  } finally {
    web = null;
    control?.close();
    stopWorker(local.child);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (process.platform !== "win32") process.off("SIGHUP", restartWeb);
  }
}

module.exports = { superviseWeb };
