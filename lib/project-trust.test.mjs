import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { bindProjectOpening, getChatProjectPolicy, getProjectTrustStatus, setProjectTrustDecision } from "./project-trust.ts";

const exec = promisify(execFile);

async function createProjectFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omp-frond-project-trust-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  return { root, cwd, agentDir };
}

async function addTool(cwd) {
  const dir = join(cwd, ".omp", "tools");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "review.ts"), "throw new Error('The inventory must not import this');\n");
}

test("empty or metadata-only directories do not need trust", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  const tools = join(cwd, ".omp", "tools");
  await mkdir(tools, { recursive: true });
  await mkdir(join(cwd, ".omp", "extensions"));
  await writeFile(join(tools, "README.md"), "metadata only");
  await writeFile(join(tools, "types.d.ts"), "export {};\n");
  await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  const assessment = await getProjectTrustStatus(cwd, agentDir);
  assert.equal(assessment.requiresTrust, false);
  assert.deepEqual(assessment.resources, []);
  assert.deepEqual(await getChatProjectPolicy(cwd, agentDir, undefined), {
    requiresTrust: false, decided: true, trusted: false, projectRoot: cwd,
  });
});

test("the inventory lists executable sources without running them", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await addTool(cwd);
  await mkdir(join(cwd, ".omp", "extensions", "package"), { recursive: true });
  await mkdir(join(cwd, ".omp", "hooks", "pre"), { recursive: true });
  await writeFile(join(cwd, ".omp", "extensions", "package", "index.ts"), "throw new Error('do not import');");
  await writeFile(join(cwd, ".omp", "hooks", "pre", "read.sh"), "exit 1");
  await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { probe: { command: "false" } } }));
  const { resources, requiresTrust, trusted } = await getProjectTrustStatus(cwd, agentDir);
  assert.equal(requiresTrust, true);
  assert.equal(trusted, false);
  assert.deepEqual(resources.map(({ kind, path }) => [kind, path.replaceAll("\\", "/")]), [
    ["mcp", ".mcp.json"], ["extension", ".omp/extensions/package/index.ts"],
    ["hook", ".omp/hooks/pre/read.sh"], ["tool", ".omp/tools/review.ts"],
  ]);
});

test("one opening never grants another opening or a different chat", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await addTool(cwd);
  const openingId = randomUUID();
  assert.equal((await getChatProjectPolicy(cwd, agentDir, openingId, "saved")).decided, false);
  assert.equal((await setProjectTrustDecision(cwd, agentDir, cwd, "trust-chat", openingId, "saved")).trusted, true);
  assert.equal((await getChatProjectPolicy(cwd, agentDir, openingId, "saved")).trusted, true);
  assert.equal((await getChatProjectPolicy(cwd, agentDir, openingId, "other")).trusted, false);
  assert.equal((await getChatProjectPolicy(cwd, agentDir, randomUUID(), "saved")).decided, false);
  assert.equal((await getProjectTrustStatus(cwd, agentDir)).decision, null);
});

test("an explicit distrust for a new chat follows that chat after its ID is assigned", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await addTool(cwd);
  const openingId = randomUUID();
  await setProjectTrustDecision(cwd, agentDir, cwd, "distrust-chat", openingId);
  assert.equal((await getChatProjectPolicy(cwd, agentDir, openingId)).decided, true);
  bindProjectOpening(openingId, "saved");
  assert.deepEqual(await getChatProjectPolicy(cwd, agentDir, openingId, "saved"), {
    requiresTrust: true, decided: true, trusted: false, projectRoot: cwd,
  });
  assert.equal((await getChatProjectPolicy(cwd, agentDir, openingId)).decided, false);
});

test("root decisions are inherited by subdirectories and linked worktrees, not separate folders", async (t) => {
  const { cwd, root, agentDir } = await createProjectFixture(t);
  await exec("git", ["init", "-q", cwd]);
  await exec("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture", "--allow-empty"]);
  const linked = join(root, "linked");
  await exec("git", ["-C", cwd, "worktree", "add", "--detach", linked]);
  const sub = join(cwd, "sub");
  const linkedSub = join(linked, "sub");
  await mkdir(sub);
  await mkdir(linkedSub);
  await addTool(cwd);
  await addTool(linked);

  await setProjectTrustDecision(linkedSub, agentDir, cwd, "always-trust", randomUUID());
  const { decision, inherited, decisionPath, resources } = await getProjectTrustStatus(sub, agentDir);
  assert.deepEqual({ decision, inherited, decisionPath }, { decision: true, inherited: true, decisionPath: cwd });
  assert.equal(resources[0]?.kind, "tool");
  assert.equal((await getChatProjectPolicy(linkedSub, agentDir, undefined, "saved")).trusted, true);
  await setProjectTrustDecision(sub, agentDir, cwd, "always-distrust", randomUUID());
  assert.equal((await getChatProjectPolicy(linkedSub, agentDir, undefined, "saved")).trusted, false);
  assert.equal((await getProjectTrustStatus(root, agentDir)).decision, null);
  const recorded = JSON.parse(await readFile(join(agentDir, "omp-frond-project-decisions.json"), "utf8"));
  assert.deepEqual(Object.values(recorded), [false]);
});

test("legacy project allow-lists do not silently authorize a wider scope", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await addTool(cwd);
  await writeFile(join(agentDir, "omp-frond-trusted-projects.json"), JSON.stringify({ [cwd]: true }));
  const policy = await getChatProjectPolicy(cwd, agentDir, undefined, "saved");
  assert.equal(policy.decided, false);
  assert.equal(policy.trusted, false);
});
