import { useCallback, type ReactNode } from "react";
import { usePromptCacheLossDialog } from "@/components/PromptCacheLossDialog";
import { sendAgentCommand, sendConfirmingCacheLoss, type RuntimeSessionBinding } from "@/lib/agent-client";

/**
 * Reloads the open chat's resources from a settings panel, asking first while
 * its prompt cache is warm. Render `dialog` in the panel.
 */
export function useSessionReload({ sessionId, runtimeId, openingId, onRuntimeIdentity, onReloaded }: {
  sessionId: string | null | undefined;
  runtimeId?: string;
  openingId?: string;
  onRuntimeIdentity?: RuntimeSessionBinding["onIdentity"];
  onReloaded?: (runtimeId: string | null) => void;
}): {
  /** False when there is no chat to reload or the user kept its cache. */
  reload: () => Promise<boolean>;
  dialog: ReactNode;
} {
  const { confirm, dialog } = usePromptCacheLossDialog();
  const reload = useCallback(async () => {
    if (!sessionId) return false;
    const binding = { current: runtimeId ?? null, openingId, onIdentity: onRuntimeIdentity };
    const reloaded = await sendConfirmingCacheLoss(
      (confirmCacheLoss) => sendAgentCommand(sessionId, confirmCacheLoss ? { type: "reload", confirmCacheLoss } : { type: "reload" }, binding),
      confirm,
    );
    if (reloaded) onReloaded?.(binding.current);
    return reloaded;
  }, [confirm, onReloaded, onRuntimeIdentity, runtimeId, sessionId, openingId]);
  return { reload, dialog };
}
