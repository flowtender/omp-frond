"use client";

import { useEffect, useRef, useState } from "react";
import type { ModelPresetView } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePopupPlacement } from "@/hooks/usePopupPlacement";
import { popupOffset } from "@/lib/popup-placement";
import { SelectorRow } from "./SelectorRow";

/**
 * The composer's chip for omp's model presets: names the preset the role setup
 * matches and activates another with one click.
 */
export function ModelPresetSwitcher({ presets, disabled, busy, onActivate }: {
  presets: ModelPresetView[];
  disabled: boolean;
  /** A preset is being activated. */
  busy: boolean;
  onActivate: (name: string) => void;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const placement = usePopupPlacement(ref, open, { viewportFraction: 0.5, cap: 420 });
  const inactive = disabled || busy;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideMouseDown);
    return () => document.removeEventListener("mousedown", closeOnOutsideMouseDown);
  }, [open]);

  const usable = presets.filter((preset) => !preset.invalid);
  if (usable.length === 0) return null;
  const activePreset = usable.find((preset) => preset.active);

  return (
    <div ref={ref} style={{ position: "relative", minWidth: 0, flexShrink: 0 }}>
      <button
        onClick={() => setOpen((value) => !value)}
        disabled={inactive}
        title={t("chat.modelPresets")}
        aria-label={t("chat.modelPresets")}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          justifyContent: isMobile ? "flex-start" : undefined,
          padding: isMobile ? "8px 10px" : "8px 12px",
          height: 32,
          maxWidth: isMobile ? "100%" : 200,
          overflow: "hidden",
          background: open ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: 9,
          color: "var(--text-muted)",
          cursor: inactive ? "not-allowed" : "pointer",
          fontSize: 12,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(event) => {
          if (inactive) return;
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
          event.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
          <line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2.2" />
          <line x1="4" y1="17" x2="20" y2="17" /><circle cx="15" cy="17" r="2.2" />
        </svg>
        <span className="chat-composer-value" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {busy ? t("presets.activating") : activePreset?.name ?? t("chat.modelPresets")}
        </span>
      </button>
      {open && (
        <div style={{
          position: "absolute",
          ...popupOffset(placement.side),
          left: 0,
          zIndex: 100,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
          overflowY: "auto",
          maxHeight: placement.maxHeight,
          minWidth: 260,
          maxWidth: "min(420px, calc(100vw - 32px))",
          padding: "4px 0",
        }}>
          {usable.map((preset) => (
            <SelectorRow
              key={preset.name}
              active={preset.active}
              onSelect={() => {
                setOpen(false);
                if (!preset.active) onActivate(preset.name);
              }}
            >
              <span style={{ fontWeight: preset.active ? 600 : 500 }}>{preset.name}</span>
              <span style={{
                flexShrink: 0,
                padding: "1px 6px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-subtle)",
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: "0.06em",
              }}>
                {t(`presets.source.${preset.source}`)}
              </span>
              <span style={{
                marginLeft: "auto",
                paddingLeft: 12,
                color: "var(--text-dim)",
                fontSize: 11,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {preset.resolved.default ?? preset.modelRoles.default ?? ""}
              </span>
            </SelectorRow>
          ))}
        </div>
      )}
    </div>
  );
}
