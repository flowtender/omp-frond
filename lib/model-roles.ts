import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import {
  formatModelRoleAlias,
  getKnownRoleIds,
  getRoleInfo,
  MODEL_ROLE_ALIAS_PREFIX,
  MODEL_ROLES,
  MODEL_ROLE_IDS,
  type ModelRole,
} from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { resolveModelRoleValue, rolePriorityDefaults } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { modelPerfKey } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { describeModelCompactionPoint } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { scopedRolePool } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/model-browser";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRoleAssignment, ModelRoleFallback, ModelRoleModelRef, ModelRoleScope } from "./api-types";
import { resolveVisibleModels } from "./model-scope";
import { getSetting } from "./omp-settings";

export type { ModelRoleAssignment, ModelRoleModelRef, ModelRoleScope };

/**
 * omp's model roles, projected onto the web UI.
 *
 * omp does not have "the" model: it has a model per *scope of work* — `default`
 * for normal turns, `smol` for cheap subagent work, `slow` for deep reasoning,
 * `plan` for plan mode, `commit` for changelog generation, and so on, plus
 * roles for non-chat model kinds (`image`, `web`, `speech`, `dictation`,
 * `judge`). The TUI
 * exposes these through `/model` and Ctrl+P; this module is the equivalent data
 * source for the browser, so both surfaces read and write the same
 * `modelRoles` record in `~/.omp/agent/config.yml`.
 */

function toModelRef(model: Model<Api>, thinkingLevel?: string): ModelRoleModelRef {
  return {
    provider: model.provider,
    modelId: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/**
 * The `default` role as a plain model reference.
 *
 * Session startup uses this the way pi-web used `settings.defaultModel`: as the
 * preferred model when the browser did not pick one explicitly.
 */
export function readDefaultModelRole(settings: Settings): { provider: string; modelId: string } | undefined {
  const selector = settings.getModelRole("default");
  if (!selector) return undefined;
  const slash = selector.indexOf("/");
  if (slash <= 0) return undefined;
  // Strip a `:thinkingLevel` suffix; startup applies thinking separately.
  const modelId = selector.slice(slash + 1).split(":")[0];
  if (!modelId) return undefined;
  return { provider: selector.slice(0, slash), modelId };
}

/**
 * The role omp falls back to when a role is unset: its `ROLE_CONFIGURED_FALLBACK`
 * plus the default-inheritance of `smol` and `slow` in `config/model-resolver.ts`,
 * neither of which the SDK exports. `describeUnsetRole` checks the answer against
 * the resolver, so a drifted table loses the role name instead of showing a wrong one.
 */
const FALLBACK_ROLE: Record<string, string> = {
  smol: "default",
  slow: "default",
  tiny: "smol",
  memory: "tiny",
  widget: "smol",
  advisor: "slow",
};

function fallbackRoleOf(role: string): string | undefined {
  const fixed = FALLBACK_ROLE[role];
  if (fixed) return fixed;
  // Kind roles (judge, ...) chain to other roles in their built-in priority list.
  const alias = rolePriorityDefaults(role).find((pattern) => pattern.startsWith(MODEL_ROLE_ALIAS_PREFIX));
  return alias?.slice(MODEL_ROLE_ALIAS_PREFIX.length).split(":")[0];
}

function sameModel(a: Model<Api> | undefined, b: Model<Api> | undefined): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.id === b.id;
}

/** What an unset role runs, and which role it falls back to when that role resolves to the same model. */
function describeUnsetRole(role: string, settings: Settings, availableModels: Model<Api>[]): ModelRoleFallback {
  const resolveAlias = (alias: string) =>
    resolveModelRoleValue(formatModelRoleAlias(alias), availableModels, { settings });
  const effective = resolveAlias(role);
  const candidate = fallbackRoleOf(role);
  const viaCandidate = candidate && candidate !== role && sameModel(effective.model, resolveAlias(candidate).model);
  return {
    ...(viaCandidate ? { role: candidate } : {}),
    ...(effective.model ? { model: toModelRef(effective.model, effective.thinkingLevel) } : {}),
    priorityChain: rolePriorityDefaults(role),
  };
}

/**
 * Every role omp knows about, with its configured selector, what that selector
 * (or, when unset, omp's fallback) resolves to against the currently available
 * models, and the facts omp's own Models hub shows beside a role.
 */
export function listModelRoles(
  settings: Settings,
  availableModels: Model<Api>[],
): ModelRoleAssignment[] {
  const builtinIds = new Set<string>(MODEL_ROLE_IDS);
  const cycleOrder = getSetting<string[]>(settings, "cycleOrder") ?? [];
  const retryChains = getSetting<Record<string, string[]>>(settings, "retry.fallbackChains") ?? {};
  const modelPerf = settings.getStorage()?.getModelPerf();
  return getKnownRoleIds(settings).map((role) => {
    const info = getRoleInfo(role, settings);
    const selector = settings.getModelRole(role);
    const resolution = selector
      ? resolveModelRoleValue(selector, availableModels, { settings })
      : undefined;
    const fallback = selector ? undefined : describeUnsetRole(role, settings, availableModels);
    const runningModel = resolution?.model ?? (fallback?.model && availableModels.find(
      (model) => model.provider === fallback.model?.provider && model.id === fallback.model?.modelId,
    ));
    const perf = runningModel ? modelPerf?.get(modelPerfKey(`${runningModel.provider}/${runningModel.id}`)) : undefined;
    const globalSelector = settings.getGlobalModelRole(role);
    const projectSelector = settings.getProjectModelRole(role);
    const cycleIndex = cycleOrder.indexOf(role);
    const retryChain = retryChains[role];

    return {
      role,
      ...(info.tag ? { tag: info.tag } : {}),
      name: info.name,
      ...(info.color ? { color: String(info.color) } : {}),
      builtin: builtinIds.has(role),
      hidden: Boolean(MODEL_ROLES[role as ModelRole]?.hidden),
      section: info.section,
      ...(selector ? { selector } : {}),
      source: settings.getModelRoleSource(role),
      provenance: settings.getModelRoleProvenance(role),
      ...(globalSelector || projectSelector
        ? { layers: { ...(globalSelector ? { global: globalSelector } : {}), ...(projectSelector ? { project: projectSelector } : {}) } }
        : {}),
      ...(cycleIndex >= 0 ? { cycleIndex: cycleIndex + 1 } : {}),
      ...(retryChain?.length ? { retryChain } : {}),
      ...(resolution?.model ? { resolved: toModelRef(resolution.model, resolution.thinkingLevel) } : {}),
      ...(fallback ? { fallback } : {}),
      ...(runningModel
        ? {
            facts: {
              compaction: describeModelCompactionPoint(settings, runningModel),
              ...(perf ? { perf: { samples: perf.samples, tps: perf.tps, ttftMs: perf.ttftMs } } : {}),
            },
          }
        : {}),
      ...(resolution?.warning ? { warning: resolution.warning } : {}),
    };
  });
}

/**
 * Models a role may be assigned: the chat models the `enabledModels` filters
 * leave visible, plus every available non-chat runner (keyless `local` and
 * `web` models), which those filters do not scope — omp's `scopedRolePool`.
 */
export async function listRoleModelPool(modelRegistry: ModelRegistry, settings: Settings): Promise<Model<Api>[]> {
  const { visible } = await resolveVisibleModels(modelRegistry, getSetting<string[]>(settings, "enabledModels"), settings);
  return scopedRolePool(visible, modelRegistry);
}

/**
 * Assign (or clear) a role's model.
 *
 * `scope: "project"` writes `.omp/config.yml` next to the project so a
 * repository can pin its own reviewer or commit model; `"global"` writes the
 * user's `~/.omp/agent/config.yml`. Passing `selector: undefined` clears the
 * assignment at that layer and lets the next layer down take over.
 */
export function writeModelRole(
  settings: Settings,
  role: string,
  selector: string | undefined,
  scope: ModelRoleScope,
): void {
  if (scope === "project") {
    if (selector) settings.setProjectModelRole(role, selector);
    else settings.clearProjectModelRole(role);
    return;
  }
  settings.setModelRole(role, selector);
}

/** Format a model plus optional thinking level back into a role selector. */
export function formatRoleSelector(
  model: { provider: string; modelId: string },
  thinkingLevel?: string,
): string {
  const base = `${model.provider}/${model.modelId}`;
  return thinkingLevel && thinkingLevel !== "off" ? `${base}:${thinkingLevel}` : base;
}
