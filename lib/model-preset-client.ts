import type { ModelPresetActivateResponse, ModelRoleScope } from "./api-types";
import { PROMPT_CACHE_WARM_CODE, type PromptCacheLossWarning } from "./prompt-cache-shared";

export interface ModelPresetActivation {
  cwd?: string;
  name: string;
  scope: ModelRoleScope;
  /** The open chat (its runtime id while it has one), switched when the preset is activated. */
  session?: string;
}

interface AskCacheLossOptions {
  confirmLabel: string;
  alternateLabel: string;
}

export type AskCacheLoss = (
  warning: PromptCacheLossWarning,
  options: AskCacheLossOptions,
) => Promise<"confirm" | "alternate" | "cancel">;

/** The activate route's answer: done, or held back because the open chat's cache is warm. */
async function postActivation(
  body: Record<string, unknown>,
  openingId?: string,
): Promise<ModelPresetActivateResponse | { cacheLoss: PromptCacheLossWarning }> {
  const response = await fetch("/api/model-presets/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(openingId ? { "X-OMP-Project-Opening": openingId } : {}) },
    body: JSON.stringify(body),
  });
  if (response.status === 428 && openingId) {
    window.dispatchEvent(new CustomEvent("omp-project-approval-required", { detail: openingId }));
  }
  const data = await response.json() as ModelPresetActivateResponse & { error?: string; code?: string; cacheLoss?: PromptCacheLossWarning };
  if (data.code === PROMPT_CACHE_WARM_CODE && data.cacheLoss) return { cacheLoss: data.cacheLoss };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/**
 * Activates a preset; when that would discard the open chat's warm prompt
 * cache, asks first. `keptChat`: the user chose to leave the chat on its
 * model. Resolves null when the user cancelled and nothing was written.
 */
export async function activateModelPresetAskingCacheLoss(
  request: ModelPresetActivation,
  openingId: string | undefined,
  askCacheLoss: AskCacheLoss,
  labels: AskCacheLossOptions,
): Promise<{ response: ModelPresetActivateResponse; keptChat: boolean } | null> {
  const first = await postActivation({ ...request }, openingId);
  if (!("cacheLoss" in first)) return { response: first, keptChat: false };
  const choice = await askCacheLoss(first.cacheLoss, labels);
  if (choice === "cancel") return null;
  const keptChat = choice === "alternate";
  const second = await postActivation({ ...request, liveSwitch: keptChat ? "skip" : "switch" }, openingId);
  if ("cacheLoss" in second) throw new Error("The activation was held back again");
  return { response: second, keptChat };
}
