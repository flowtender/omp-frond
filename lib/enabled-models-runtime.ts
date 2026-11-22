import { homedir } from "os";
import { join, sep } from "path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { resolveModelScope } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
// A separate type-only import: under jiti (the integration tests' loader), an
// inline `type ScopedModel` specifier here made rpc-manager's model registry
// stop seeing saved models.yml edits (rpc-manager-model-config test).
import type { ScopedModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import {
  computeEnabledModelsState,
  type EnabledModelsInput,
  type EnabledModelsModelView,
  type EnabledModelsProviderView,
  type EnabledModelsReadOnlyReason,
  type EnabledModelsView,
  type PatternResolution,
} from "./enabled-models";
import { findSetting, getSetting, setSetting, unsetSetting } from "@/lib/omp-settings";

/**
 * SDK adapter for the pure `enabledModels` editor in `lib/enabled-models.ts`.
 *
 * Pattern matching lives in omp's resolver, so each configured pattern is
 * resolved on its own here to learn which models it covers and which thinking
 * level it pins. Resolving them one by one — instead of all at once, like
 * `lib/model-scope.ts` does for the selector — is what lets an edit touch only
 * the pattern responsible for a given model.
 */

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Resolve every configured pattern separately, keeping the input order.
 *
 * A snapshot registry keeps the matching rules identical without re-reading
 * the credential store between patterns. `settings` lets role aliases
 * (`@smol`) resolve the way they do in a session.
 */
export async function resolvePatternMatches(
  patterns: readonly string[],
  models: readonly Model<Api>[],
  settings?: Settings,
): Promise<PatternResolution[]> {
  const snapshotRegistry = { getAvailable: () => [...models] };
  const resolutions: PatternResolution[] = [];
  for (const pattern of patterns) {
    let scopedModels: ScopedModel[] = [];
    try {
      scopedModels = await resolveModelScope([pattern], snapshotRegistry, undefined, settings);
    } catch {
      // A malformed entry still belongs to the user's config; treat it as
      // matching nothing so it is preserved verbatim.
      scopedModels = [];
    }
    const pin = scopedModels.find((scoped) => scoped.explicitThinkingLevel && scoped.thinkingLevel)?.thinkingLevel;
    resolutions.push({
      pattern,
      matched: scopedModels.map((scoped) => modelRef(scoped.model)),
      ...(pin ? { pin } : {}),
    });
  }
  return resolutions;
}

/** Glob shapes tried for a provider, shortest first. */
const PROVIDER_GLOB_CANDIDATES = ["*", "**"];

/**
 * For each provider, the shortest glob that resolves to exactly its models.
 *
 * `provider/*` is not that glob whenever a model id contains a slash: omp
 * matches globs with `Bun.Glob`, whose `*` stops at `/`, so `commandcode/*`
 * misses `commandcode/sakana/fugu-ultra` and every other nested id. Writing an
 * assumed glob would silently disable those models, so each candidate is
 * resolved and kept only when its match set is exactly the provider's model
 * set. A provider that no candidate covers is simply absent here and gets
 * explicit entries.
 */
export async function resolveProviderGlobs(
  models: readonly Model<Api>[],
): Promise<Record<string, string>> {
  const refsByProvider = new Map<string, Set<string>>();
  for (const model of models) {
    const refs = refsByProvider.get(model.provider);
    if (refs) refs.add(modelRef(model));
    else refsByProvider.set(model.provider, new Set([modelRef(model)]));
  }

  const globs: Record<string, string> = {};
  for (const [provider, refs] of refsByProvider) {
    const candidates = PROVIDER_GLOB_CANDIDATES.map((suffix) => `${provider}/${suffix}`);
    for (const resolution of await resolvePatternMatches(candidates, models)) {
      if (resolution.matched.length !== refs.size) continue;
      if (!resolution.matched.every((ref) => refs.has(ref))) continue;
      globs[provider] = resolution.pattern;
      break;
    }
  }
  return globs;
}

export async function buildEnabledModelsInput(
  patterns: string[] | undefined,
  models: readonly Model<Api>[],
  options: { settings?: Settings; withProviderGlobs?: boolean } = {},
): Promise<EnabledModelsInput> {
  return {
    patterns,
    availableRefs: models.map(modelRef),
    resolutions: await resolvePatternMatches(patterns ?? [], models, options.settings),
    // Only an edit needs them; the read-only view never writes a pattern.
    ...(options.withProviderGlobs ? { providerGlobs: await resolveProviderGlobs(models) } : {}),
  };
}

export interface EnabledModelsViewOptions {
  input: EnabledModelsInput;
  models: readonly Model<Api>[];
  providerNames: ReadonlyMap<string, string>;
  /** Available references not seen before (`lib/seen-models.ts`). */
  newRefs: ReadonlySet<string>;
  settingsPath: string;
  readOnlyReason?: EnabledModelsReadOnlyReason;
  modelError?: string;
}

export function buildEnabledModelsView({
  input,
  models,
  providerNames,
  newRefs,
  settingsPath,
  readOnlyReason,
  modelError,
}: EnabledModelsViewOptions): EnabledModelsView {
  const state = computeEnabledModelsState(input);
  const enabled = new Set(state.enabled);

  const byProvider = new Map<string, EnabledModelsModelView[]>();
  for (const model of models) {
    const ref = modelRef(model);
    const pin = state.pins[ref];
    const entry: EnabledModelsModelView = {
      id: model.id,
      name: model.name || model.id,
      ref,
      enabled: enabled.has(ref),
      isNew: newRefs.has(ref),
      ...(model.contextWindow == null ? {} : { contextWindow: model.contextWindow }),
      ...(pin ? { thinkingPin: pin } : {}),
    };
    const list = byProvider.get(model.provider);
    if (list) list.push(entry);
    else byProvider.set(model.provider, [entry]);
  }

  const providers: EnabledModelsProviderView[] = [...byProvider.entries()].map(([id, entries]) => {
    entries.sort((a, b) => modelNameCollator.compare(a.name, b.name) || modelNameCollator.compare(a.id, b.id));
    return {
      id,
      name: providerNames.get(id) ?? id,
      enabledCount: entries.filter((entry) => entry.enabled).length,
      models: entries,
    };
  });
  providers.sort((a, b) => modelNameCollator.compare(a.name, b.name) || modelNameCollator.compare(a.id, b.id));

  return {
    allEnabled: state.allEnabled,
    patterns: input.patterns ?? null,
    stalePatterns: state.stalePatterns,
    enabledTotal: state.enabled.length,
    availableTotal: input.availableRefs.length,
    newTotal: input.availableRefs.filter((ref) => newRefs.has(ref)).length,
    providers,
    settingsPath,
    editable: readOnlyReason === undefined,
    ...(readOnlyReason ? { readOnlyReason } : {}),
    ...(modelError ? { modelError } : {}),
  };
}

export interface EnabledModelsSettings {
  /** Effective value for the cwd, i.e. what the model selector actually applies. */
  patterns: string[] | undefined;
  /** The file that value came from, with the home directory shortened to `~`. */
  path: string;
  /** Set when the switches must not write; see `EnabledModelsReadOnlyReason`. */
  readOnlyReason?: EnabledModelsReadOnlyReason;
}

/** `~/.omp/agent/config.yml` reads better in a banner than the full path. */
export function displaySettingsPath(path: string): string {
  const home = homedir();
  if (!home || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  return rest === "" || rest.startsWith(sep) ? `~${rest}` : path;
}

/**
 * Read the effective `enabledModels` for a cwd-scoped `Settings` and say where
 * it comes from.
 *
 * Writes only ever reach the global `config.yml`, like the TUI's. A project
 * value replaces the global one instead of merging, so with one present every
 * toggle would be a no-op; and a global entry scoped to paths
 * (`{ path, models }`) is something the pattern editor cannot reproduce. Both
 * are reported instead of written around.
 */
export function readEnabledModelsSettings(settings: Settings): EnabledModelsSettings {
  const setting = findSetting("enabledModels");
  if (!setting) throw new Error("omp has no enabledModels setting");
  const effective = getSetting<string[]>(settings, "enabledModels");
  const patterns = effective && effective.length > 0 ? [...effective] : undefined;
  const globalPath = displaySettingsPath(join(settings.getAgentDir(), "config.yml"));

  if (settings.getProvenance(setting) === "project") {
    return { patterns, path: displaySettingsPath(settings.getCwd()), readOnlyReason: "project-scope" };
  }
  const globalValue: unknown = settings.getGlobalSettings().enabledModels;
  if (Array.isArray(globalValue) && globalValue.some((entry) => typeof entry !== "string")) {
    return { patterns, path: globalPath, readOnlyReason: "path-scoped" };
  }
  return { patterns, path: globalPath };
}

/**
 * Persist a new global `enabledModels` through the process-wide `Settings`, so
 * omp's own save path merges just that key into the current `config.yml`.
 */
export async function writeEnabledModels(settings: Settings, patterns: string[] | undefined): Promise<void> {
  if (patterns === undefined) unsetSetting(settings, "enabledModels");
  else setSetting(settings, "enabledModels", patterns);
  await settings.flush();
}

export type { EnabledModelsModelView, EnabledModelsProviderView, EnabledModelsView };
