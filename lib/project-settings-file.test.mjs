import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { projectConfigPath, removeProjectSettings, writeProjectSetting } = await jiti.import("./project-settings-file.ts");

function withProject(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-project-settings-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

const readConfig = (root) => parseYaml(readFileSync(projectConfigPath(root), "utf8"));

test("a project write creates .omp/config.yml and nests the setting by its path", () => withProject(async (root) => {
  await writeProjectSetting(root, ["browser", "enabled"], false);
  await writeProjectSetting(root, ["tools", "maxTimeout"], 30);

  assert.deepEqual(readConfig(root), { browser: { enabled: false }, tools: { maxTimeout: 30 } });
}));

test("a project write keeps the file's other settings and its mode", () => withProject(async (root) => {
  mkdirSync(join(root, ".omp"));
  writeFileSync(projectConfigPath(root), "modelRoles:\n  default: acme/primary\nbrowser:\n  headless: false\n");
  chmodSync(projectConfigPath(root), 0o640);

  await writeProjectSetting(root, ["browser", "enabled"], false);

  assert.deepEqual(readConfig(root), { modelRoles: { default: "acme/primary" }, browser: { headless: false, enabled: false } });
  assert.equal(statSync(projectConfigPath(root)).mode & 0o777, 0o640);
}));

test("using the global value removes the setting and the mappings it leaves empty", () => withProject(async (root) => {
  await writeProjectSetting(root, ["modelRoles", "default"], "acme/primary");
  await writeProjectSetting(root, ["browser", "enabled"], false);
  await writeProjectSetting(root, ["tools", "speculativeExecution", "enabled"], true);

  await removeProjectSettings(root, [["browser", "enabled"], ["tools", "speculativeExecution", "enabled"], ["grep", "enabled"]]);

  assert.deepEqual(readConfig(root), { modelRoles: { default: "acme/primary" } });
}));

test("using the global value in a project without a config creates nothing", () => withProject(async (root) => {
  await removeProjectSettings(root, [["browser", "enabled"]]);

  assert.throws(() => statSync(join(root, ".omp")), { code: "ENOENT" });
}));

test("a config that is not a YAML mapping is left untouched", () => withProject(async (root) => {
  mkdirSync(join(root, ".omp"));
  writeFileSync(projectConfigPath(root), "- a list\n");

  await assert.rejects(writeProjectSetting(root, ["browser", "enabled"], false), /not a YAML mapping/);
  assert.equal(readFileSync(projectConfigPath(root), "utf8"), "- a list\n");
}));
