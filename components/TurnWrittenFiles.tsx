"use client";

import { useId, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

/**
 * Lists the files a turn actually wrote, as buttons that open each one in the
 * preview pane. Entries come from the turn's successful `write`/`edit` tool
 * calls — the reply text is never scanned for paths.
 */
export function TurnWrittenFiles({ files, onOpenFile }: {
  files: WrittenFile[];
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  if (files.length === 0) return null;

  return (
    <>
      <button type="button" className="turn-files-trigger" aria-haspopup="dialog" aria-controls={id}
        onClick={(event) => {
          const dialog = dialogRef.current;
          if (!dialog) return;
          const anchor = event.currentTarget.getBoundingClientRect();
          const below = window.innerHeight - anchor.bottom;
          const openBelow = anchor.top < 220 && below > anchor.top;
          dialog.style.setProperty("--turn-files-top", openBelow ? `${anchor.bottom + 6}px` : "auto");
          dialog.style.setProperty("--turn-files-bottom", openBelow ? "auto" : `${Math.max(8, window.innerHeight - anchor.top + 6)}px`);
          dialog.style.setProperty("--turn-files-right", `${Math.max(8, window.innerWidth - anchor.right)}px`);
          dialog.style.setProperty("--turn-files-space", `${Math.max(60, (openBelow ? below : anchor.top) - 14)}px`);
          dialog.showModal();
        }}>
        <span aria-hidden="true">▸</span>
        {t(files.length === 1 ? "chat.fileWrittenCount" : "chat.filesWrittenCount", { count: files.length })}
      </button>
      <dialog ref={dialogRef} id={id} className="turn-files-popover" aria-labelledby={`${id}-title`}
        onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className="turn-files-panel">
          <div className="turn-files-heading">
            <strong id={`${id}-title`}>{t("chat.filesWritten")}</strong>
            <button type="button" aria-label={t("i18n.close")} onClick={() => dialogRef.current?.close()}>×</button>
          </div>
          <ul>
            {files.map(({ filePath }) => {
              const name = getFileName(filePath);
              const directory = filePath.slice(0, -name.length);
              return (
                <li key={filePath}>
                  <button type="button" title={filePath} aria-label={t("chat.openWrittenFile", { name: filePath })}
                    onClick={() => { dialogRef.current?.close(); onOpenFile?.(filePath); }}>
                    {getFileIcon(name, 14)}
                    <span><strong>{name}</strong><small>{directory}</small></span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </dialog>
    </>
  );
}
