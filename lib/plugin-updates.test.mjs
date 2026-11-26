import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { checkPluginUpdates } = await createJiti(import.meta.url).import("./plugin-updates.ts");

test("npm update child receives sanitized environment and npm controls", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-update-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
  const seen = join(root, "env.json");
  const script = join(root, "child.cjs");
  writeFileSync(script, `const names = ["PI_WEB_PASSWORD", "OMP_WEB_PASSWORD", "PORT", "NODE_ENV", "NEXT_RUNTIME", "npm_config_registry"]; require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name] ?? null])))); console.log(JSON.stringify("2.0.0"));`);
  const values = { PI_WEB_PASSWORD: "sentinel-pi", OMP_WEB_PASSWORD: "sentinel-omp", PORT: "1234", NODE_ENV: "production", NEXT_RUNTIME: "sentinel", npm_config_registry: "https://registry.example.invalid", PI_OFFLINE: "0" };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const [result] = await checkPluginUpdates(root, undefined, {
    packages: [{ source: "npm:synthetic-package", scope: "user", installedPath: root }],
    npmCommand: [process.execPath, script],
  });
  assert.equal(result.state, "update-available", result.message);
  const env = JSON.parse(readFileSync(seen, "utf8"));
  for (const key of ["PI_WEB_PASSWORD", "OMP_WEB_PASSWORD", "PORT", "NODE_ENV", "NEXT_RUNTIME"]) assert.equal(env[key], null);
  assert.equal(env.npm_config_registry, values.npm_config_registry);
});

test("Git update checks disable interactive prompts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-git-update-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "0";
  t.after(() => { if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline; });
  const calls = [];
  const hash = "a".repeat(40);
  const [result] = await checkPluginUpdates(root, undefined, {
    packages: [{ source: "git:github.com/example/plugin", scope: "user", installedPath: root }],
    runCommand: async (command, args, options) => {
      calls.push(options);
      if (args.includes("--abbrev-ref")) return "origin/main";
      return args[0] === "ls-remote" ? `${hash}\trefs/heads/main` : hash;
    },
  });
  assert.equal(result.state, "up-to-date");
  assert.equal(calls.length, 3);
  for (const { env } of calls) assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});
