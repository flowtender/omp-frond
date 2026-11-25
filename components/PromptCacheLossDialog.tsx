"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PromptCacheLossWarning } from "@/lib/prompt-cache-shared";
import { openStackedDialog } from "@/lib/stacked-dialog";

/** `confirm` goes ahead; `alternate` is a caller's third way out (Activate's "Only for new chats"). */
export type PromptCacheLossChoice = "confirm" | "alternate" | "cancel";

export interface PromptCacheLossDialogOptions {
  /** Replaces the confirm button's label for the change's kind. */
  confirmLabel?: string;
  /** Adds a third button between Cancel and confirm. */
  alternateLabel?: string;
}

const CONFIRM_LABEL_KEYS = {
  model: "cacheLoss.switchAnyway",
  thinking: "cacheLoss.changeAnyway",
  reload: "cacheLoss.reloadAnyway",
} as const;

/**
 * Asks before a change that would make the chat's next message miss its warm
 * prompt cache: what changes, how long the cache would otherwise last, and a
 * way to keep it. Escape and the backdrop cancel.
 */
export function PromptCacheLossDialog({ warning, minutesLeft, options = {}, onChoose }: {
  warning: PromptCacheLossWarning;
  /** Whole minutes until the entry lapses on its own, read when the question was asked. */
  minutesLeft?: number;
  options?: PromptCacheLossDialogOptions;
  onChoose: (choice: PromptCacheLossChoice) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const textId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onChooseRef = useRef(onChoose);
  useEffect(() => {
    onChooseRef.current = onChoose;
  }, [onChoose]);
  // It can open above Settings: Escape closes it alone and focus returns to what had it.
  useEffect(() => openStackedDialog(document, dialogRef.current, () => onChooseRef.current("cancel")), []);

  const { change } = warning;
  const description = change.kind === "reload"
    ? t("cacheLoss.reload")
    : t(change.kind === "model" ? "cacheLoss.model" : "cacheLoss.thinking", { from: change.from, to: change.to });
  return (
    <div
      role="presentation"
      className="confirm-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onChoose("cancel");
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        tabIndex={-1}
        className="confirm-dialog"
      >
        <div className="confirm-dialog-body">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="confirm-dialog-icon">
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          <div className="confirm-dialog-content">
            <div id={titleId} className="confirm-dialog-title">{t("cacheLoss.title")}</div>
            <div id={textId} className="confirm-dialog-text">
              {description}
              {minutesLeft !== undefined && <> {t("cacheLoss.timeLeft", { minutes: minutesLeft })}</>}
            </div>
          </div>
        </div>
        <div className="confirm-dialog-footer">
          <button type="button" className="confirm-dialog-button" onClick={() => onChoose("cancel")}>
            {t("cacheLoss.cancel")}
          </button>
          {options.alternateLabel && (
            <button type="button" className="confirm-dialog-button" onClick={() => onChoose("alternate")}>
              {options.alternateLabel}
            </button>
          )}
          <button type="button" className="confirm-dialog-button is-primary" onClick={() => onChoose("confirm")}>
            {options.confirmLabel ?? t(CONFIRM_LABEL_KEYS[change.kind])}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PendingQuestion {
  warning: PromptCacheLossWarning;
  minutesLeft?: number;
  options?: PromptCacheLossDialogOptions;
  resolve: (choice: PromptCacheLossChoice) => void;
}

/**
 * The warm-cache question as a promise. Render `dialog` where the caller
 * lives; `confirm` fits `sendConfirmingCacheLoss()` from `lib/agent-client.ts`.
 */
export function usePromptCacheLossDialog(): {
  ask: (warning: PromptCacheLossWarning, options?: PromptCacheLossDialogOptions) => Promise<PromptCacheLossChoice>;
  confirm: (warning: PromptCacheLossWarning) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingQuestion | null>(null);
  // Not Promise.withResolvers(): Safari before 17.4 lacks it, and the client targets iOS 16.2.
  const ask = useCallback((warning: PromptCacheLossWarning, options?: PromptCacheLossDialogOptions) => {
    const minutesLeft = warning.expiresAt === undefined
      ? undefined
      : Math.max(1, Math.ceil((warning.expiresAt - Date.now()) / 60_000));
    return new Promise<PromptCacheLossChoice>((resolve) => setPending({ warning, minutesLeft, options, resolve }));
  }, []);
  const confirm = useCallback(async (warning: PromptCacheLossWarning) => await ask(warning) === "confirm", [ask]);
  const dialog = pending && (
    <PromptCacheLossDialog
      warning={pending.warning}
      minutesLeft={pending.minutesLeft}
      options={pending.options}
      onChoose={(choice) => {
        setPending(null);
        pending.resolve(choice);
      }}
    />
  );
  return { ask, confirm, dialog };
}
