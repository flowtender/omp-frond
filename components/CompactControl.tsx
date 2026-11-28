"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { COMPACT_MODES, type CompactRequest } from "@/lib/compact-modes";
import { CompactHelpDialog } from "./CompactHelpDialog";
import { SelectorRow } from "./SelectorRow";

/**
 * The composer's compact button. Idle, it opens a menu of omp's compaction
 * methods plus a help dialog that explains them; while compacting, it stops the
 * compaction.
 */
export function CompactControl({ isMobile, isCompacting, isStrayClick, onCompact, onAbortCompaction }: {
  isMobile: boolean;
  isCompacting: boolean;
  /** A click that landed on this button only because Stop vacated its place. */
  isStrayClick: (event: MouseEvent) => boolean;
  onCompact: (request: CompactRequest) => void;
  onAbortCompaction?: () => void;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [menuOpen]);

  const label = isCompacting ? t("chat.stopCompaction") : t("chat.compactContext");
  const restingBackground = isCompacting ? "rgba(239,68,68,0.08)" : menuOpen ? "var(--bg-selected)" : "none";
  const restingColor = isCompacting ? "#ef4444" : menuOpen ? "var(--text)" : "var(--text-muted)";

  return (
    // On a phone the menu hangs from the controls' right edge, which keeps it on screen wherever this button sits.
    <div ref={containerRef} style={{ position: isMobile ? "static" : "relative" }}>
      <button
        onClick={isCompacting ? onAbortCompaction : (event) => { if (!isStrayClick(event)) setMenuOpen((open) => !open); }}
        aria-haspopup={isCompacting ? undefined : "menu"}
        aria-expanded={isCompacting ? undefined : menuOpen}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          padding: isMobile ? "0 6px" : "8px 12px",
          width: isMobile ? "auto" : undefined,
          height: 32,
          background: restingBackground,
          border: "none",
          // An inset ring, not a border, so opening the menu doesn't change the button's size.
          boxShadow: menuOpen && !isCompacting ? "inset 0 0 0 1px var(--accent)" : "none",
          borderRadius: 9,
          color: restingColor,
          cursor: "pointer",
          fontSize: 12,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.16)" : "var(--bg-hover)";
          event.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = restingBackground;
          event.currentTarget.style.color = restingColor;
        }}
        title={label}
        aria-label={label}
      >
        {isCompacting ? (
          <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg><span style={{ whiteSpace: "nowrap" }}>{t("chat.compacting")}</span></>
        ) : (
          <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
            <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
          </svg><span style={{ whiteSpace: "nowrap" }}>{t("chat.compact")}</span></>
        )}
      </button>
      {menuOpen && !isCompacting && (
        <div
          role="menu"
          aria-label={t("chat.compactMenu")}
          style={{
            position: "absolute", bottom: "calc(100% + 6px)", right: 0,
            maxWidth: "calc(100vw - 32px)",
            zIndex: 100, background: "var(--bg)", border: "1px solid var(--accent)",
            borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
            overflow: "hidden", minWidth: 180,
          }}
        >
          {COMPACT_MODES.map((mode) => (
            <SelectorRow
              key={mode}
              active={false}
              onSelect={() => {
                setMenuOpen(false);
                onCompact({ mode });
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)" }}>{mode}</span>
              <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{t(`chat.compactMode.${mode}.short`)}</span>
            </SelectorRow>
          ))}
          <div style={{ borderTop: "1px solid var(--border)" }}>
            <SelectorRow
              active={false}
              onSelect={() => {
                setMenuOpen(false);
                setHelpOpen(true);
              }}
            >
              {t("chat.compactHelp")}
            </SelectorRow>
          </div>
        </div>
      )}
      {helpOpen && <CompactHelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
