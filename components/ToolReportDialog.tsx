import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "./MarkdownBody";

export function ToolReportDialog({ markdown, onClose }: { markdown: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  return (
    <dialog
      className="tools-report-dialog"
      ref={dialog}
      aria-labelledby="tools-report-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <header>
        <h2 id="tools-report-title">{t("tools.available")}</h2>
        <button type="button" aria-label={t("chat.close")} onClick={onClose}>×</button>
      </header>
      <div className="tools-report-content"><MarkdownBody>{markdown}</MarkdownBody></div>
    </dialog>
  );
}
