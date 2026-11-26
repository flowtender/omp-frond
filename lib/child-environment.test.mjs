import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

const { sanitizeProjectCommandEnvironment, projectGitEnvironment } = await createJiti(import.meta.url).import("./child-environment.ts");

test("project children remove host variables without losing Git and npm controls", () => {
  const base = { PATH: "/bin", GIT_CONFIG_GLOBAL: "/tmp/gitconfig", npm_config_registry: "https://registry.example.invalid", PI_WEB_PASSWORD: "sentinel", OMP_WEB_PASSWORD: "sentinel", PORT: "1234", NODE_ENV: "production", NEXT_RUNTIME: "nodejs", LC_ALL: "fr_FR" };
  const before = { ...base };
  const env = sanitizeProjectCommandEnvironment(base);
  for (const key of ["PI_WEB_PASSWORD", "OMP_WEB_PASSWORD", "PORT", "NODE_ENV", "NEXT_RUNTIME"]) assert.equal(env[key], undefined);
  assert.equal(env.PATH, base.PATH);
  assert.equal(env.GIT_CONFIG_GLOBAL, base.GIT_CONFIG_GLOBAL);
  assert.equal(env.npm_config_registry, base.npm_config_registry);
  assert.equal(projectGitEnvironment(base).LC_ALL, "C");
  assert.deepEqual(base, before);
});

test("Windows project environments filter names case-insensitively", () => {
  const env = sanitizeProjectCommandEnvironment({ omp_web_password: "sentinel", Pi_Web_Password: "sentinel", Next_Runtime: "nodejs", Path: "kept" }, "win32");
  assert.deepEqual(env, { Path: "kept" });
});


test("a child receives only the filtered synthetic Git environment", () => {
  const env = projectGitEnvironment({
    PI_WEB_PASSWORD: "sentinel-pi",
    OMP_WEB_PASSWORD: "sentinel-omp",
    PORT: "1234",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const script = `console.log(JSON.stringify([process.env.PI_WEB_PASSWORD ?? null, process.env.OMP_WEB_PASSWORD ?? null, process.env.PORT ?? null, process.env.GIT_CONFIG_NOSYSTEM, process.env.LC_ALL]));`;
  const result = execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(result), [null, null, null, "1", "C"]);
});