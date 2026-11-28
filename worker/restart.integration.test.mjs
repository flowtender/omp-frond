import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { requestWorker } from "../lib/worker-client.ts";
import { configuredLauncher, listLauncherWorkers, restartLauncherWorker } from "../lib/worker-control.ts";

const { superviseWeb } = createRequire(import.meta.url)("../bin/worker-supervisor.js");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Stands in for Next: reports the environment the launcher gives the web server.
const FAKE_WEB = `console.log(JSON.stringify({ pid: process.pid, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("OMP_FROND_"))) })); setInterval(() => {}, 1000);`;

async function startLauncher(root) {
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const { promise: reported, resolve } = Promise.withResolvers();
  let output = "";
  const supervised = superviseWeb({
    bunPath: process.execPath,
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: agentDir,
    },
    nextArgs: ["-e", FAKE_WEB],
    onWebOutput(chunk) {
      output += chunk;
      if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]));
    },
  });
  supervised.catch(() => {});
  return { web: await Promise.race([reported, supervised.then(() => Promise.reject(new Error("launcher exited early")))]), supervised };
}

test("the launcher restarts its worker on the same port and token, and the new worker starts empty", { timeout: 40_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omp-frond-restart-")));
  const { web, supervised } = await startLauncher(root);
  t.after(async () => {
    process.kill(web.pid, "SIGKILL");
    await supervised;
    await rm(root, { recursive: true, force: true });
  });

  const worker = {
    workerId: web.env.OMP_FROND_WORKER_ID,
    port: Number(web.env.OMP_FROND_WORKER_PORT),
    token: web.env.OMP_FROND_WORKER_TOKEN,
  };
  const launcher = configuredLauncher(web.env);
  assert.ok(launcher, "the web server gets the launcher's address");
  const workerRequest = (path, init) => requestWorker(worker, new Request(`http://localhost${path}`, init));

  assert.deepEqual(await listLauncherWorkers(launcher), [{ id: "local", state: "running", managed: true }]);

  // State only the running worker process holds: a folder it was told to allow.
  const folder = join(root, "project");
  await mkdir(folder);
  const listing = `/api/files/${folder.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join("/")}?type=list`;
  assert.notEqual((await workerRequest(listing)).status, 200);
  const validated = await workerRequest("/api/cwd/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: folder }),
  });
  assert.equal(validated.status, 200);
  assert.equal((await workerRequest(listing)).status, 200);

  await restartLauncherWorker(launcher, "local");

  assert.deepEqual(await listLauncherWorkers(launcher), [{ id: "local", state: "running", managed: true }]);
  assert.notEqual((await workerRequest(listing)).status, 200, "the restarted worker is a new process");
  assert.equal((await workerRequest("/api/agent/running")).status, 200, "same port and token still reach it");

  await assert.rejects(restartLauncherWorker(launcher, "elsewhere"), { status: 404 });
});
