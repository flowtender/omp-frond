import { useCallback, useEffect, useRef } from "react";
import type { SharedSessionDraft } from "@/lib/session-draft-shared";
import { getSessionDraftSync, type SessionDraftComposer } from "@/lib/session-draft-sync";

// How often a visible composer asks the server for a newer draft.
const POLL_INTERVAL_MS = 2500;

export interface SharedSessionDraftOptions {
  /** The saved session shown in the composer, or null for a new or unsaved session. */
  sessionId: string | null;
  readDraft: () => SharedSessionDraft;
  applyRemoteDraft: (draft: SharedSessionDraft) => void;
}

/**
 * Keeps the composer's draft for a saved session in step with other devices
 * viewing it (lib/session-draft-sync.ts). Returns `saveSoon`, which the composer
 * calls after each local change to schedule a save.
 */
export function useSharedSessionDraft({ sessionId, readDraft, applyRemoteDraft }: SharedSessionDraftOptions): () => void {
  const composerRef = useRef({ readDraft, applyRemoteDraft });

  useEffect(() => {
    composerRef.current = { readDraft, applyRemoteDraft };
  });

  useEffect(() => {
    if (!sessionId) return;
    const sync = getSessionDraftSync(sessionId);
    const composer: SessionDraftComposer = {
      readDraft: () => composerRef.current.readDraft(),
      applyRemoteDraft: (draft) => composerRef.current.applyRemoteDraft(draft),
    };
    sync.attach(composer);
    void sync.refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void sync.refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      sync.detach(composer);
      // Save what this composer held; the sync reads the draft store once detached.
      sync.kick();
    };
  }, [sessionId]);

  return useCallback(() => {
    if (sessionId) getSessionDraftSync(sessionId).kick();
  }, [sessionId]);
}
