"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
/* eslint-enable @typescript-eslint/no-require-imports */

const WORKER_STOP_MS = 7_000;

function stopWorker(child) {
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  child.kill();
  const deadline = setTimeout(() => child.kill("SIGKILL"), WORKER_STOP_MS);
  child.once("exit", () => clearTimeout(deadline));
}

async function startWorker(bunPath, cwd, env) {
  const { OMP_FROND_WORKER_ID: workerId, OMP_FROND_WORKER_PORT: port, OMP_FROND_WORKER_TOKEN: token } = env;
  if (workerId || port || token || env.OMP_FROND_WORKER_HOST) {
    if (!workerId || !/^[\w-]{1,64}$/.test(workerId) || !/^\d+$/.test(port ?? "")
      || Number(port) < 1 || Number(port) > 65535 || !/^[0-9a-f]{64}$/.test(token ?? "")) {
      throw new Error("An external worker requires OMP_FROND_WORKER_ID, OMP_FROND_WORKER_PORT, and OMP_FROND_WORKER_TOKEN.");
    }
    return { env, child: null };
  }

  const localId = "local";
  const localToken = randomBytes(32).toString("hex");
  const workerEnv = {
    ...env,
    OMP_FROND_LOCAL_WORKER: "1",
    OMP_FROND_WORKER_ID: localId,
    OMP_FROND_WORKER_TOKEN: localToken,
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
        if (message.workerId === localId && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
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
    const boundPort = await promise;
    return {
      child,
      env: {
        ...env,
        OMP_FROND_WORKER_ID: localId,
        OMP_FROND_WORKER_PORT: String(boundPort),
        OMP_FROND_WORKER_TOKEN: localToken,
      },
    };
  } catch (error) {
    stopWorker(child);
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function superviseWeb({ bunPath, cwd, env, nextArgs, onWebOutput }) {
  let worker = null;
  let web = null;
  let stopSignal;
  let restart = false;
  const stop = (signal) => {
    stopSignal = signal;
    web?.kill(signal);
    stopWorker(worker);
  };
  const restartWeb = () => {
    if (stopSignal || !web) return;
    restart = true;
    web.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (process.platform !== "win32") process.on("SIGHUP", restartWeb);
  try {
    const started = await startWorker(bunPath, cwd, env);
    worker = started.child;
    worker?.once("exit", (code, signal) => {
      if (!stopSignal && web) console.error(`SDK worker stopped (${signal ?? code}); the web server is still running.`);
    });

    while (!stopSignal) {
      restart = false;
      web = spawn(bunPath, nextArgs, { cwd, env: started.env, stdio: ["inherit", "pipe", "inherit"] });
      web.stdout.on("data", onWebOutput ?? ((chunk) => process.stdout.write(chunk)));
      const [code, signal] = await once(web, "exit");
      if (!restart && !stopSignal) return code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
    }
    return stopSignal === "SIGINT" ? 130 : 143;
  } finally {
    web = null;
    stopWorker(worker);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (process.platform !== "win32") process.off("SIGHUP", restartWeb);
  }
}

module.exports = { superviseWeb };
