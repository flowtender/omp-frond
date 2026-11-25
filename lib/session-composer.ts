import { cfgMotionResolved } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { getModelMatchPreferences, pickDefaultAvailableModel, resolveAllowedModels, resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { newSessionThinkingLevel, parseConfiguredThinkingLevel, resolveConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking/levels";
import type { ShimmerMode } from "@oh-my-pi/pi-tui/text/shimmer";
import type { AgentSessionLike } from "./omp-types";
import { readSessionToolSelection } from "./session-tool-selection";
import { getPresetFromToolNames, type ToolPreset } from "./tool-presets";
import type { SessionContext, SessionEntry } from "./types";

type SessionModelSelection = Pick<SessionContext, "model" | "modelRole">;
type ComposerSelection = SessionModelSelection & Pick<SessionContext, "thinkingLevel" | "configuredThinkingLevel">;

export type SessionComposerSnapshot = SessionModelSelection & {
  thinkingLevel: string;
  configuredThinkingLevel: string;
  source: "restored" | "live";
  toolPreset: ToolPreset;
  toolNames: string[] | null;
  /** omp's `cfgMotionResolved` shimmer: a mode, or "disabled" when motion effects are off. */
  shimmer: ShimmerMode | "disabled";
};

export async function readRestoredComposer(
  selection: ComposerSelection,
  entries: readonly SessionEntry[],
  settings: Settings,
  registry: Pick<ModelRegistry, "find" | "getAvailable" | "hasConfiguredAuth" | "hasConcreteAuth">,
): Promise<SessionComposerSnapshot> {
  let { model, modelRole, thinkingLevel, configuredThinkingLevel } = selection;
  if (modelRole === null || configuredThinkingLevel === null) {
    const matchPreferences = getModelMatchPreferences(settings);
    const allowed = await resolveAllowedModels(registry, settings, matchPreferences);
    const defaultRole = resolveModelRoleValue(settings.getModelRole("default"), allowed, { settings, matchPreferences });
    // A model observed in an assistant response isn't a saved model selection.
    const startupModel = modelRole === null
      ? defaultRole.model ?? pickDefaultAvailableModel(
        allowed.filter((candidate) => registry.hasConfiguredAuth(candidate)),
        (provider) => registry.hasConcreteAuth(provider),
      )
      : model ? registry.find(model.provider, model.modelId) : undefined;
    if (modelRole === null && startupModel) {
      model = { provider: startupModel.provider, modelId: startupModel.id };
      modelRole = "default";
    }
    if (configuredThinkingLevel === null) {
      const selector = newSessionThinkingLevel(
        startupModel,
        defaultRole.explicitThinkingLevel ? defaultRole.thinkingLevel : undefined,
        parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings)),
      );
      thinkingLevel = resolveConfiguredThinkingLevel(startupModel, selector) ?? null;
      configuredThinkingLevel = selector === "auto" ? selector : thinkingLevel;
    }
  }
  const tools = readSessionToolSelection(entries);
  return {
    source: "restored", model, modelRole,
    thinkingLevel: thinkingLevel ?? "off",
    configuredThinkingLevel: configuredThinkingLevel ?? "off",
    toolPreset: tools ? getPresetFromToolNames(tools) : "configured",
    toolNames: tools ?? null,
    shimmer: cfgMotionResolved.get(settings).shimmer,
  };
}

export function readLiveComposer(session: AgentSessionLike): SessionComposerSnapshot {
  const model = session.model;
  const thinkingLevel = session.agent.state?.thinkingLevel ?? "off";
  return {
    source: "live",
    model: model ? { provider: model.provider, modelId: model.id } : null,
    modelRole: session.sessionManager.getLastModelChangeRole() ?? (model ? "default" : null),
    thinkingLevel,
    configuredThinkingLevel: session.configuredThinkingLevel() ?? thinkingLevel,
    toolPreset: getPresetFromToolNames(session.getActiveToolNames()),
    toolNames: readSessionToolSelection(session.sessionManager.getEntries() as unknown as SessionEntry[]) ?? null,
    shimmer: cfgMotionResolved.get(session.settings).shimmer,
  };
}
