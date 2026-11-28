import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowFileRoot } from "../../../lib/allowed-roots.ts";

const root = await mkdtemp(join(tmpdir(), "frond-mcp-settings-"));
const agent = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agent;
await mkdir(agent);
const { GET, PUT, PATCH } = await import("./route.ts");
test.after(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(t) {
  const cwd = await mkdtemp(join(root, "project-"));
  await mkdir(join(cwd, ".omp"));
  await rm(join(agent, "mcp.json"), { force: true });
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, path: join(cwd, ".omp", "mcp.json") };
}
function request(cwd, method = "GET", body) {
  return new Request(`http://localhost/api/mcp?${new URLSearchParams({ cwd })}`, {
    method, ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

test("inert projection and unchanged redactions round-trip without exposing secrets", async (t) => {
  const { cwd, path } = await fixture(t);
  const marker = join(cwd, "executed");
  const project = { mcpServers: {
    local: { command: "node", args: ["server.js", "--token", "literal-arg-secret"], env: { RUN: `!touch ${marker}`, NORMAL: "ordinary-value" }, extra: "hidden-extra" },
    remote: { type: "http", url: "https://user:password@example.invalid/mcp?token=url-secret", headers: { Authorization: "header-secret" }, oauth: { nested: ["oauth-secret"] } },
  } };
  await writeFile(path, JSON.stringify(project));
  await writeFile(join(agent, "mcp.json"), JSON.stringify({ disabledServers: ["local"], enabledServers: ["remote"] }));
  const result = await (await GET(request(cwd))).json();
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /literal-arg-secret|url-secret|password|header-secret|oauth-secret|ordinary-value|touch |hidden-extra/);
  assert.equal(result.project.servers[0].enabled, false);
  assert.equal(result.project.servers[1].enabled, true);
  assert.deepEqual(result.project.servers[0].config.args, ["server.js", "--token", "•••"]);
  assert.equal(await readFile(marker, "utf8").catch(() => null), null);
  const response = await PUT(request(cwd, "PUT", { scope: "project", servers: result.project.servers }));
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.scope.servers[0].enabled, false);
  assert.doesNotMatch(JSON.stringify(saved), /literal-arg-secret|url-secret|password|header-secret|oauth-secret/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).mcpServers, project.mcpServers);
  const changed = structuredClone(result.project.servers);
  changed[1].config.url += "&other=1";
  assert.equal((await PUT(request(cwd, "PUT", { scope: "project", servers: changed }))).status, 400);
});

test("alternate project sources stay visible without expanding host variables", async (t) => {
  const { cwd } = await fixture(t);
  const path = join(cwd, ".mcp.json");
  await writeFile(path, JSON.stringify({ mcpServers: {
    sidecar: { command: "${PATH}", args: ["${PATH}"], env: { SAFE: "${PATH}" } },
  } }));
  const { project } = await (await GET(request(cwd))).json();
  assert.equal(project.servers.length, 1);
  const [server] = project.servers;
  assert.equal(server.name, "sidecar");
  assert.equal(server.editable, false);
  assert.equal(server.source.path, path);
  assert.equal(server.config.command, "${PATH}");
  assert.deepEqual(server.config.args, ["${PATH}"]);
  assert.notEqual(server.config.env.SAFE, process.env.PATH);
});

test("malformed, excessive, nonregular and outside-linked files fail safely", async (t) => {
  const { cwd, path } = await fixture(t);
  await writeFile(path, '{"mcpServers": invalid-secret}');
  let result = await (await GET(request(cwd))).json();
  assert.match(result.project.error, /valid JSON/);
  assert.doesNotMatch(JSON.stringify(result), /invalid-secret/);
  await writeFile(path, JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [String(i), {}])) }));
  result = await (await GET(request(cwd))).json();
  assert.match(result.project.error, /excessive/);
  await rm(path);
  const outside = join(root, "outside.json");
  await writeFile(outside, JSON.stringify({ mcpServers: { outsideSecret: { command: "node" } } }));
  await symlink(outside, path);
  result = await (await GET(request(cwd))).json();
  assert.match(result.project.error, /outside/);
  assert.doesNotMatch(JSON.stringify(result), /outsideSecret/);
  assert.equal((await PUT(request(cwd, "PUT", { scope: "project", servers: [] }))).status, 400);
  assert.equal((await PATCH(request(cwd, "PATCH", { scope: "project", name: "outsideSecret", enabled: false }))).status, 400);
  await rm(path);
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path]);
    result = await (await GET(request(cwd))).json();
    assert.match(result.project.error, /regular file/);
  }
});

test("user and project toggles preserve effective overrides", async (t) => {
  const { cwd, path } = await fixture(t);
  await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { user: { command: "node" } }, disabledServers: ["user"] }));
  await writeFile(path, JSON.stringify({ mcpServers: { project: { command: "node", enabled: false } } }));
  let result = await (await GET(request(cwd))).json();
  assert.equal(result.user.servers[0].enabled, false);
  assert.equal(result.project.servers[0].enabled, false);
  assert.equal((await PATCH(request(cwd, "PATCH", { scope: "user", name: "user", enabled: true }))).status, 200);
  assert.equal((await PATCH(request(cwd, "PATCH", { scope: "project", name: "project", enabled: true }))).status, 200);
  result = await (await GET(request(cwd))).json();
  assert.equal(result.user.servers[0].enabled, true);
  assert.equal(result.project.servers[0].enabled, true);
});
