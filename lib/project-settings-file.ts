import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { getProjectAgentDir, isRecord, stringifyYamlConfig, withFileLock } from "@oh-my-pi/pi-utils";
import { parse as parseYaml } from "yaml";
import { writeFileAtomicSync } from "./atomic-file";

/**
 * A project's own omp settings file, `<project>/.omp/config.yml`.
 *
 * omp's `Settings` writes only model roles to the project layer, so omp-web
 * edits this file itself for every other setting. It holds the lock omp's own
 * writer takes (`withFileLock` on the real path), writes the same YAML
 * (`stringifyYamlConfig`), and keeps the file's mode. A file that does not
 * parse is left untouched.
 */

type RawSettings = Record<string, unknown>;

const PROJECT_CONFIG_FILE_NAME = "config.yml";
const NEW_PROJECT_CONFIG_MODE = 0o644;

export function projectConfigPath(projectRoot: string): string {
  return join(getProjectAgentDir(projectRoot), PROJECT_CONFIG_FILE_NAME);
}

function parseProjectConfig(path: string): RawSettings {
  if (!existsSync(path)) return {};
  const parsed: unknown = parseYaml(readFileSync(path, "utf8"));
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) throw new Error(`${path} is not a YAML mapping`);
  return parsed;
}

function setAtSegments(config: RawSettings, segments: readonly string[], value: unknown): void {
  let node = config;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    if (!isRecord(child)) node[segment] = {};
    node = node[segment] as RawSettings;
  }
  node[segments[segments.length - 1]] = value;
}

/** Removes the value at `segments`, then every mapping the removal left empty. */
function deleteAtSegments(config: RawSettings, segments: readonly string[]): boolean {
  const [head, ...rest] = segments;
  if (!Object.hasOwn(config, head)) return false;
  if (rest.length === 0) {
    delete config[head];
    return true;
  }
  const child = config[head];
  if (!isRecord(child) || !deleteAtSegments(child, rest)) return false;
  if (Object.keys(child).length === 0) delete config[head];
  return true;
}

async function updateProjectConfig(projectRoot: string, update: (config: RawSettings) => boolean): Promise<void> {
  const path = projectConfigPath(projectRoot);
  mkdirSync(getProjectAgentDir(projectRoot), { recursive: true });
  const writePath = existsSync(path) ? realpathSync(path) : path;
  await withFileLock(writePath, async () => {
    const config = parseProjectConfig(writePath);
    if (!update(config)) return;
    const mode = existsSync(writePath) ? statSync(writePath).mode & 0o777 : NEW_PROJECT_CONFIG_MODE;
    writeFileAtomicSync(writePath, stringifyYamlConfig(config), mode);
  });
}

export async function writeProjectSetting(projectRoot: string, segments: readonly string[], value: unknown): Promise<void> {
  await updateProjectConfig(projectRoot, (config) => {
    setAtSegments(config, segments, value);
    return true;
  });
}

/** Removes each setting from the project file, so the global value applies again. */
export async function removeProjectSettings(projectRoot: string, settings: ReadonlyArray<readonly string[]>): Promise<void> {
  if (!existsSync(projectConfigPath(projectRoot))) return;
  await updateProjectConfig(projectRoot, (config) => {
    let changed = false;
    for (const segments of settings) changed = deleteAtSegments(config, segments) || changed;
    return changed;
  });
}
