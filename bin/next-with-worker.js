"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const { statSync } = require("node:fs");
const { join } = require("node:path");
const { withLoopbackNoProxy } = require("./runtime");
const { resolveAgentDir } = require("./web-auth-store");
const { superviseWeb } = require("./worker-supervisor");
/* eslint-enable @typescript-eslint/no-require-imports */

const WORKER_LOCK_FILENAME = "omp-frond-worker.lock"; // worker/main.ts holds it for the agent home
const LOCK_STALE_MS = 10_000; // proper-lockfile's default: an older lock is taken over, but never deleted

/** Modification time of the lock, or undefined when it does not exist. */
function lockMtimeMs(lockPath) {
  try {
    return statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
}

/** A restarted dev server races the old worker's lock; wait until it is released or goes stale. */
async function waitForWorkerLock() {
  const lockPath = join(resolveAgentDir(), WORKER_LOCK_FILENAME);
  const isHeld = () => {
    const mtimeMs = lockMtimeMs(lockPath);
    return mtimeMs !== undefined && Date.now() - mtimeMs < LOCK_STALE_MS;
  };
  if (!isHeld()) return;
  console.error(`Waiting for the previous SDK worker to release ${lockPath}…`);
  while (isHeld()) await new Promise((done) => setTimeout(done, 1000));
}

async function main() {
  if (process.argv[2] === "dev") await waitForWorkerLock();
  return superviseWeb({
    cwd,
    env: withLoopbackNoProxy(process.env),
    bunPath: process.execPath,
    nextArgs: ["--bun", next, ...process.argv.slice(2)],
  });
}

const cwd = join(__dirname, "..");
const next = require.resolve("next/dist/bin/next", { paths: [cwd] });
main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`Failed to launch omp-frond: ${error.message}`);
  process.exitCode = 1;
});
