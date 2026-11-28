"use client";

import { useEffect, useId, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { COMPACT_MODES } from "@/lib/compact-modes";
import { openStackedDialog } from "@/lib/stacked-dialog";

/** What each compaction method does, and what it costs, for choosing one from the compact menu. */
export function CompactHelpDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => openStackedDialog(document, dialogRef.current, () => onCloseRef.current()), []);

  return (
    <div
      role="presentation"
      className="confirm-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="confirm-dialog"
        style={{ width: 560 }}
      >
        <div className="confirm-dialog-body">
          <div className="confirm-dialog-content">
            <div id={titleId} className="confirm-dialog-title">{t("chat.compactHelpTitle")}</div>
            <div className="confirm-dialog-text">{t("chat.compactHelpIntro")}</div>
            {COMPACT_MODES.map((mode) => (
              <section key={mode} style={{ marginTop: 16 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{mode}</div>
                <div className="confirm-dialog-text">{t(`chat.compactMode.${mode}.what`)}</div>
                <dl style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.6, color: "var(--text-muted)" }}>
                  <dt style={{ fontWeight: 600, color: "var(--text)" }}>{t("chat.compactHelpPros")}</dt>
                  <dd style={{ margin: "0 0 4px" }}>{t(`chat.compactMode.${mode}.pros`)}</dd>
                  <dt style={{ fontWeight: 600, color: "var(--text)" }}>{t("chat.compactHelpCons")}</dt>
                  <dd style={{ margin: "0 0 4px" }}>{t(`chat.compactMode.${mode}.cons`)}</dd>
                  <dt style={{ fontWeight: 600, color: "var(--text)" }}>{t("chat.compactHelpFocus")}</dt>
                  <dd style={{ margin: 0 }}>{t(`chat.compactMode.${mode}.focus`)}</dd>
                </dl>
              </section>
            ))}
            <div className="confirm-dialog-text" style={{ marginTop: 16 }}>{t("chat.compactHelpSlash")}</div>
          </div>
        </div>
        <div className="confirm-dialog-footer">
          <button type="button" className="confirm-dialog-button is-primary" onClick={onClose}>
            {t("chat.compactHelpClose")}
          </button>
        </div>
      </div>
    </div>
  );
}
