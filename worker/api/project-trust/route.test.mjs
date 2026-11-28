import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { allowFileRoot } from "../../../lib/allowed-roots.ts";
import { GET, POST } from "./route.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-frond-trust-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".omp", "tools"), { recursive: true });
  await writeFile(join(cwd, ".omp", "tools", "review.ts"), "export default function () {}\n");
  allowFileRoot(cwd);
  return { root, cwd, path: getMCPConfigPath("project", cwd) };
}

async function load(cwd) {
  const response = await GET(new Request(`http://localhost/api/project-trust?${new URLSearchParams({ cwd })}`));
  assert.equal(response.status, 200);
  return response.json();
}

test("a project with executable tools and no MCP file stays restricted without an MCP error", async (t) => {
  const { cwd, path } = await fixture(t);
  const status = await load(cwd);
  assert.equal(status.requiresTrust, true);
  assert.equal(status.trusted, false);
  assert.equal(status.projectRoot, cwd);
  assert.deepEqual(status.resources, [{ kind: "tool", path: join(".omp", "tools", "review.ts") }]);
  assert.equal(status.decision, null);
  assert.deepEqual(status.mcpFile, { scope: "project", path, exists: false, problems: [] });
  assert.deepEqual(status.mcpServers, []);
});

test("the pre-trust listing describes OMP entries without resolving or exposing their values", async (t) => {
  const { cwd, path } = await fixture(t);
  await writeFile(path, JSON.stringify({ mcpServers: {
    local: { command: "node", args: ["server.js", "--token", "local-secret"], env: {
      RUN: "!not-a-real-command", SECRET: "${EXAMPLE_TOKEN}", BACKUP: "EXAMPLE_BACKUP",
    } },
    remote: { type: "sse", url: "https://example.invalid/mcp?token=remote-secret", enabled: "FALSE",
      headers: { Authorization: "Bearer " + "literal-header-secret" }, env: { IGNORED: "!no" } },
  } }));
  const status = await load(cwd);
  const [local, remote] = status.mcpServers;
  assert.equal(status.trusted, false);
  assert.equal(status.mcpFile.exists, true);
  assert.equal(local.command, "node");
  assert.deepEqual(local.args, ["server.js", "--token", "•••"]);
  assert.deepEqual(local.commandFields, [{ kind: "env", name: "RUN" }]);
  assert.deepEqual(local.variableReferences, [
    { kind: "env", name: "SECRET", variables: ["EXAMPLE_TOKEN"] },
    { kind: "env", name: "BACKUP", variables: ["EXAMPLE_BACKUP"] },
  ]);
  assert.equal(remote.enabled, false);
  assert.equal(remote.url, "https://example.invalid/mcp?token=•••");
  assert.deepEqual(remote.headerNames, ["Authorization"]);
  assert.deepEqual(remote.commandFields, []);
  assert.doesNotMatch(JSON.stringify(status), /local-secret|remote-secret|literal-header-secret|not-a-real-command|IGNORED/);
});

test("the trust preview groups other sources by path and flags credential references and same-name user servers", async (t) => {
  const { cwd } = await fixture(t);
  const global = getMCPConfigPath("user");
  await writeFile(global, JSON.stringify({ mcpServers: { shared: { command: "node", args: ["user.js"] } } }));
  t.after(() => rm(global, { force: true }));
  const vscode = join(cwd, ".vscode", "mcp.json");
  await mkdir(join(cwd, ".vscode"));
  await writeFile(vscode, JSON.stringify({ mcp: { servers: {
    shared: { transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: "${OMP_FROND_PASSWORD}" } },
  } } }));
  const gemini = join(cwd, ".gemini", "settings.json");
  await mkdir(join(cwd, ".gemini"));
  await writeFile(gemini, JSON.stringify({ mcpServers: {
    shared: { url: "https://second.example.invalid/mcp", oauth: { clientSecret: "${OAUTH_SECRET:-not-for-browser}" } },
  } }));
  const broken = join(cwd, ".mcp.json");
  await writeFile(broken, "unparsable-with-sensitive-text");
  const status = await load(cwd);
  assert.ok(status.resources.some(({ kind, path }) => kind === "mcp" && path === join(".vscode", "mcp.json")));
  assert.deepEqual(status.mcpFiles.find(({ path }) => path === broken).problems.map(({ reason }) => reason), ["unparsable"]);
  assert.equal(status.mcpServers.length, 2);
  const headerServer = status.mcpServers.find(({ sourcePath }) => sourcePath === vscode);
  assert.equal(headerServer.replacesGlobal, true);
  assert.deepEqual(headerServer.webPasswordField, { kind: "header", name: "Authorization" });
  const oauthServer = status.mcpServers.find(({ sourcePath }) => sourcePath === gemini);
  assert.deepEqual(oauthServer.variableReferences, [{ kind: "oauth-client-secret", variables: ["OAUTH_SECRET"] }]);
  assert.doesNotMatch(JSON.stringify(status), /not-for-browser|unparsable-with-sensitive-text|user\.js/);
});

test("files outside the allowed folders and malformed files do not disclose contents", async (t) => {
  const { root, cwd, path } = await fixture(t);
  const outside = join(root, "outside.json");
  await writeFile(outside, '{"mcpServers":{"outside-only":{"command":"node"}}}');
  await symlink(outside, path);
  const linked = await load(cwd);
  assert.equal(linked.mcpFile.problems[0]?.reason, "link-outside");
  assert.deepEqual(linked.mcpServers, []);
  assert.doesNotMatch(JSON.stringify(linked), /outside-only/);

  await rm(path);
  await writeFile(path, '{"mcpServers": unquoted-secret}');
  const malformed = await load(cwd);
  assert.equal(malformed.mcpFile.problems[0]?.reason, "unparsable");
  assert.deepEqual(malformed.mcpServers, []);
  assert.doesNotMatch(JSON.stringify(malformed), /unquoted-secret/);
});

test("only the permanent options persist across openings", async (t) => {
  const { cwd } = await fixture(t);
  const { projectRoot } = await load(cwd);
  const choose = (choice, root = projectRoot) => POST(new Request("http://localhost/api/project-trust", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cwd, projectRoot: root, openingId: randomUUID(), choice, sessionId: "saved-chat" }),
  }));
  const temporary = await choose("trust-chat");
  assert.equal(temporary.status, 200);
  assert.equal((await temporary.json()).trusted, true);
  assert.equal((await load(cwd)).trusted, false);
  const stale = await choose("always-trust", join(projectRoot, "old-root"));
  assert.equal(stale.status, 409);
  assert.equal((await choose("always-distrust")).status, 200);
  assert.equal((await load(cwd)).decision, false);
});
