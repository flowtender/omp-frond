import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-open-in-explorer-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

// A route that accepts a path raises a real file-manager window, so the route
// is loaded from a copy whose launcher import is rewritten to a recorder. Under
// `bun test` jiti cannot alias "@/lib/open-in-file-manager" (tsconfig paths
// resolve it first; see components/SessionSidebar.tabs.test.mjs).
const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const recordingRouteSource = routeSource.replace(
  'from "@/lib/open-in-file-manager";',
  'from "./__fixtures__/open-in-file-manager-recorder.mjs";',
);
assert.notEqual(recordingRouteSource, routeSource, "the route's launcher import is rewritten");
const recordingRoutePath = new URL("./route.recording.generated.ts", import.meta.url);
await writeFile(recordingRoutePath, recordingRouteSource);
let POST;
try {
  ({ POST } = await jiti.import("./route.recording.generated.ts"));
} finally {
  await rm(recordingRoutePath, { force: true });
}

const launchedTargets = () => globalThis.__ompWebFileManagerLaunches ?? [];

test.after(() => rm(agentDir, { recursive: true, force: true }));

function open(cwd, host = "localhost:30141") {
  return POST(new Request("http://localhost/api/open-in-explorer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: host },
    body: JSON.stringify({ cwd }),
  }));
}

test("rejects a path outside the allowed roots before looking at it", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-web-open-in-explorer-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));

  // Existing and missing paths answer the same, so the route is no existence oracle.
  for (const cwd of [outside, path.join(outside, "missing")]) {
    const response = await open(cwd);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "access-denied" });
  }
  assert.deepEqual(launchedTargets(), []);
});

test("refuses requests that are not addressed to this machine", async () => {
  const response = await open(os.tmpdir(), "192.168.1.20:30141");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "remote" });
});
