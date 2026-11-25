import type { Settings } from "@oh-my-pi/pi-coding-agent";
import {
  deleteModelPreset,
  findActiveModelPreset,
  getModelPreset,
  getModelPresetNames,
  isValidModelPresetName,
} from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgModelPresets, type ModelPreset } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking/levels";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type {
  ModelPresetShadowedRole,
  ModelPresetShadowedThinking,
  ModelPresetView,
  ModelRoleScope,
} from "./api-types";
import { writeModelRole } from "./model-roles";
import { writeProjectSetting } from "./project-settings-file";

/**
 * omp's model presets, edited from the browser.
 *
 * omp reads, lists, matches and deletes presets with its own helpers
 * (`config/model-presets.ts`); this module adds what the settings tab needs on
 * top: editing a preset's roles in place, and activating one into the layer the
 * tab's scope switch names rather than omp's `modelRoleStorage`. Presets are
 * always saved to the global config, as omp saves them; a preset another layer
 * defines is listed and activated, never edited or deleted from here.
 *
 * Every function takes two `Settings`: `scoped` reads the project the tab is
 * open on, `global` is the process-wide instance global writes go through.
 */

export class ModelPresetError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ModelPresetError";
  }
}

export function listModelPresets(settings: Settings, available: Model<Api>[]): ModelPresetView[] {
  const active = findActiveModelPreset(settings);
  return getModelPresetNames(settings).map((name) => {
    const source = settings.getOwnedModelPreset(name)?.source ?? "global";
    const lookup = getModelPreset(settings, name);
    if (lookup.kind !== "found") {
      const invalid = lookup.kind === "invalid" ? lookup.reason : "it is missing";
      return { name, source, active: false, modelRoles: {}, resolved: {}, invalid };
    }
    const { modelRoles, defaultThinkingLevel } = lookup.preset;
    const resolved: Record<string, string> = {};
    for (const [role, selector] of Object.entries(modelRoles)) {
      const { model } = resolveModelRoleValue(selector, available, { settings });
      if (model) resolved[role] = `${model.provider}/${model.id}`;
    }
    return {
      name,
      source,
      active: name === active,
      modelRoles,
      resolved,
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
    };
  });
}

function requireValidName(name: string): void {
  if (!isValidModelPresetName(name)) {
    throw new ModelPresetError(`Invalid preset name "${name}": use a letter, then letters, digits, - or _`, 400);
  }
}

function requireGlobalPreset(scoped: Settings, name: string): void {
  const owned = scoped.getOwnedModelPreset(name);
  if (!owned) throw new ModelPresetError(`Preset not found: ${name}`, 404);
  if (owned.source !== "global") {
    throw new ModelPresetError(`Preset "${name}" is defined by the ${owned.source} config; change it there`, 409);
  }
}

const PRESET_THINKING_LEVELS = new Set<string>([AUTO_THINKING, ...THINKING_EFFORTS]);

/** A preset as the browser sends it; anything omp would refuse to read back is rejected. */
export function parseModelPresetInput(modelRoles: unknown, defaultThinkingLevel: unknown): ModelPreset {
  if (!isRecord(modelRoles)) throw new ModelPresetError("modelRoles must be a mapping", 400);
  const roles: Record<string, string> = {};
  for (const [role, selector] of Object.entries(modelRoles)) {
    if (typeof selector !== "string" || selector.trim() === "") {
      throw new ModelPresetError(`Role "${role}" is not a model selector`, 400);
    }
    roles[role] = selector.trim();
  }
  if (defaultThinkingLevel === undefined || defaultThinkingLevel === null) return { modelRoles: roles };
  if (typeof defaultThinkingLevel !== "string" || !PRESET_THINKING_LEVELS.has(defaultThinkingLevel)) {
    throw new ModelPresetError("defaultThinkingLevel is not a thinking level", 400);
  }
  return { modelRoles: roles, defaultThinkingLevel: defaultThinkingLevel as ModelPreset["defaultThinkingLevel"] };
}

/**
 * Save the current role setup as a new preset, as omp's `/modelpreset save`
 * captures it. An existing name is refused: changing a preset is the job of
 * its own detail pane.
 */
export function createModelPreset(scoped: Settings, global: Settings, name: string): void {
  requireValidName(name);
  if (scoped.getOwnedModelPreset(name)) throw new ModelPresetError(`A preset named "${name}" already exists`, 409);
  const modelRoles: Record<string, string> = {};
  for (const [role, selector] of Object.entries(scoped.getModelRoles())) {
    if (selector) modelRoles[role] = selector;
  }
  cfgModelPresets.setEntry(global, name, { modelRoles, defaultThinkingLevel: cfgDefaultThinkingLevel.get(scoped) });
}

export function updateModelPreset(scoped: Settings, global: Settings, name: string, preset: ModelPreset): void {
  requireGlobalPreset(scoped, name);
  cfgModelPresets.setEntry(global, name, preset);
}

export function removeModelPreset(scoped: Settings, global: Settings, name: string): void {
  requireGlobalPreset(scoped, name);
  deleteModelPreset(global, name);
}

/** The preset `name`, or the reason it cannot be activated. */
export function readActivatablePreset(scoped: Settings, name: string): ModelPreset {
  const lookup = getModelPreset(scoped, name);
  if (lookup.kind === "missing") throw new ModelPresetError(`Preset not found: ${name}`, 404);
  if (lookup.kind === "invalid") throw new ModelPresetError(`Preset "${name}" is malformed: ${lookup.reason}`, 409);
  return lookup.preset;
}

/**
 * Write the preset's roles and default thinking level into the `scope` layer,
 * replacing that layer's roles as a whole: a role the preset leaves unset is
 * cleared there. Nothing is written when the preset's default model is not
 * among `candidates`, as omp refuses such a switch.
 */
export async function activateModelPreset(options: {
  scoped: Settings;
  global: Settings;
  /** Required for `scope: "project"`. */
  cwd: string | undefined;
  preset: ModelPreset;
  scope: ModelRoleScope;
  candidates: Model<Api>[];
}): Promise<void> {
  const { scoped, global, cwd, preset, scope, candidates } = options;
  if (scope === "project" && !cwd) throw new ModelPresetError("Open a project to activate a preset into it", 400);
  const presetDefault = preset.modelRoles.default;
  if (presetDefault && !resolveModelRoleValue(presetDefault, candidates, { settings: scoped }).model) {
    throw new ModelPresetError(`Default model \`${presetDefault}\` is not available`, 409);
  }

  const target = scope === "global" ? global : scoped;
  const roles = new Set([...Object.keys(scoped.getModelRoles()), ...Object.keys(preset.modelRoles)]);
  for (const role of roles) {
    const selector = Object.hasOwn(preset.modelRoles, role) ? preset.modelRoles[role] : undefined;
    const setInLayer = scope === "global" ? global.getGlobalModelRole(role) : scoped.getProjectModelRole(role);
    if (selector !== undefined || setInLayer) writeModelRole(target, role, selector, scope);
  }
  if (preset.defaultThinkingLevel !== undefined && scope === "global") {
    cfgDefaultThinkingLevel.set(global, preset.defaultThinkingLevel);
  }
  await target.flush();
  if (preset.defaultThinkingLevel !== undefined && scope === "project" && cwd) {
    // omp's Settings writes only model roles to a project's config.
    await writeProjectSetting(cwd, ["defaultThinkingLevel"], preset.defaultThinkingLevel);
  }
}

/**
 * The thinking level a switch to the `default` role applies, as omp's preset
 * switch decides it: the role's own `:level`, else the preset's, else the
 * configured default. Undefined leaves the session's level alone.
 */
export function defaultRoleThinkingLevel(
  resolved: { explicitThinkingLevel: boolean; thinkingLevel?: string },
  presetLevel: string | undefined,
  configuredDefault: string | undefined,
): string | undefined {
  const level = resolved.explicitThinkingLevel ? resolved.thinkingLevel : presetLevel ?? configuredDefault;
  return level && level !== "inherit" ? level : undefined;
}

/** What another layer still decides after activating `preset`, read from freshly loaded `settings`. */
export function findPresetShadows(settings: Settings, preset: ModelPreset): {
  shadowed: ModelPresetShadowedRole[];
  shadowedThinking?: ModelPresetShadowedThinking;
} {
  const effective = settings.getModelRoles();
  const roles = [...new Set([...Object.keys(effective), ...Object.keys(preset.modelRoles)])].sort((a, b) => a.localeCompare(b));
  const shadowed: ModelPresetShadowedRole[] = [];
  for (const role of roles) {
    const expected = Object.hasOwn(preset.modelRoles, role) ? preset.modelRoles[role] : undefined;
    const actual = effective[role] || undefined;
    if (expected === actual) continue;
    shadowed.push({
      role,
      ...(expected ? { expected } : {}),
      ...(actual ? { actual } : {}),
      source: settings.getModelRoleProvenance(role),
    });
  }
  const expectedThinking = preset.defaultThinkingLevel;
  const actualThinking = cfgDefaultThinkingLevel.get(settings);
  if (expectedThinking === undefined || expectedThinking === actualThinking) return { shadowed };
  return {
    shadowed,
    shadowedThinking: {
      expected: expectedThinking,
      ...(actualThinking ? { actual: actualThinking } : {}),
      source: cfgDefaultThinkingLevel.provenance(settings),
    },
  };
}
