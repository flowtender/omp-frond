"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModelPresetActivateResponse, ModelPresetsResponse, ModelRoleAssignment } from "@/lib/api-types";
import { activateModelPresetAskingCacheLoss, type AskCacheLoss } from "@/lib/model-preset-client";
import type { TranslationParams } from "@/lib/i18n/types";
import { useI18n } from "./useI18n";

export interface ModelPresetNotice {
  type: "success" | "warning" | "error";
  message: string;
}

/**
 * omp's model presets for one chat, and activating one into the chat's
 * project (global when it has none). The list is re-read whenever the chat's
 * role table changes, since which preset is active follows the roles.
 */
export function useModelPresets({ cwd, sessionId, openingId, modelRoles, askCacheLoss, onActivated, notify }: {
  cwd: string | null;
  /** The open chat (its runtime id while it has one); switched when a preset is activated. */
  sessionId: string | null;
  openingId?: string;
  modelRoles: ModelRoleAssignment[];
  askCacheLoss: AskCacheLoss;
  /** The role setup changed: the chat re-reads its role table and model. */
  onActivated: () => Promise<void>;
  notify: (notice: ModelPresetNotice) => void;
}) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<ModelPresetsResponse["presets"]>([]);
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/model-presets${query}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as ModelPresetsResponse;
        if (response.ok && !controller.signal.aborted) setPresets(data.presets);
      })
      .catch(() => {
        // The chip stays on its last list; the Settings panel reports load errors.
      });
    return () => controller.abort();
  }, [cwd, modelRoles]);

  const activate = useCallback(async (name: string) => {
    setActivating(true);
    try {
      const request = { cwd: cwd ?? undefined, name, scope: cwd ? "project" as const : "global" as const, session: sessionId ?? undefined };
      const activated = await activateModelPresetAskingCacheLoss(request, openingId, askCacheLoss, {
        confirmLabel: t("presets.switchChat"),
        alternateLabel: t("presets.newChatsOnly"),
      });
      if (!activated) return;
      const { response, keptChat } = activated;
      setPresets(response.presets);
      notify(activationNotice(name, response, keptChat, t));
      await onActivated();
    } catch (error) {
      notify({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setActivating(false);
    }
  }, [askCacheLoss, cwd, notify, onActivated, openingId, sessionId, t]);

  return { presets, activating, activate };
}

function activationNotice(
  name: string,
  response: ModelPresetActivateResponse,
  keptChat: boolean,
  t: (key: string, params?: TranslationParams) => string,
): ModelPresetNotice {
  if (response.liveError) return { type: "error", message: t("presets.liveFailed", { error: response.liveError }) };
  const shadowed = response.shadowed.length + (response.shadowedThinking ? 1 : 0);
  const summary = response.live
    ? t("presets.activatedLive", { name, model: `${response.live.provider}/${response.live.modelId}` })
    : t(keptChat ? "presets.activatedKept" : "presets.activated", { name });
  return shadowed > 0
    ? { type: "warning", message: `${summary} ${t("presets.shadowed", { count: shadowed })}` }
    : { type: "success", message: summary };
}
