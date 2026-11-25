"use client";

import { Fragment } from "react";

import type { ModelRoleCandidate } from "@/lib/api-types";
import {
  formatModelRoleSelector,
  getModelRoleThinkingLevel,
  getModelRoleThinkingOptions,
} from "@/lib/model-role-selection";
import { useI18n } from "@/hooks/useI18n";
import { SearchableSelect } from "./SearchableSelect";

export interface ModelRoleRow {
  role: string;
  name: string;
  tag?: string;
  /** The role's selector as stored, read for its `:level` suffix. */
  selector?: string;
  /** `provider/modelId` the row shows selected; empty while the role is unset. */
  model: string;
  /** Under the role's name, e.g. which config supplies it. */
  note?: string;
  warning?: string;
  /** Other values of this role to read against the picker, e.g. a preset's saved model and the live one. */
  references?: readonly ModelRoleReference[];
}

export interface ModelRoleReference {
  label: string;
  /** A role selector, or empty when the role is unset there. */
  selector: string;
}

interface Props {
  rows: readonly ModelRoleRow[];
  /** Role id → models it may be assigned (the Models tab's filters already applied). */
  candidates: Record<string, ModelRoleCandidate[]>;
  /** Locks every row, e.g. while a write is in flight. */
  disabled?: boolean;
  /** Locks the one row whose write is in flight. */
  pendingRole?: string | null;
  /** `selector: null` unsets the role. */
  onAssign: (role: string, selector: string | null) => void;
}

/**
 * One model picker and thinking strip per role. Used for the live role setup
 * and for a preset's draft alike, so both read the same.
 */
export function ModelRoleRows({ rows, candidates, disabled = false, pendingRole = null, onAssign }: Props) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((row) => {
        const locked = disabled || pendingRole === row.role;
        const currentThinkingLevel = getModelRoleThinkingLevel(row.selector);
        const models = candidates[row.role] ?? [];
        const selected = models.find((model) => model.selector === row.model);
        const thinkingOptions = getModelRoleThinkingOptions(selected?.thinkingLevels);
        return (
          <div
            key={row.role}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "8px 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{
                flexShrink: 0,
                minWidth: 62,
                padding: "2px 6px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-subtle)",
                color: "var(--accent)",
                fontFamily: "var(--font-mono)",
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textAlign: "center",
              }}>
                {row.tag ?? row.role.toUpperCase()}
              </span>

              <div style={{ minWidth: 0, flex: "0 0 auto", width: 128 }}>
                <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 600 }}>{row.name}</div>
                {row.note && <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{row.note}</div>}
              </div>

              {/* References sit beside the picker on a wide pane and wrap above it on a narrow one. */}
              <div style={{ display: "flex", flex: 1, minWidth: 0, flexWrap: "wrap", alignItems: "center", gap: "6px 12px" }}>
                {row.references && row.references.length > 0 && (
                  <dl style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "1px 8px", margin: 0, flex: "1 1 220px", minWidth: 0, fontSize: 10.5 }}>
                    {row.references.map((reference) => (
                      <Fragment key={reference.label}>
                        <dt style={{ color: "var(--text-dim)" }}>{reference.label}</dt>
                        <dd
                          title={reference.selector || undefined}
                          style={{
                            margin: 0,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontFamily: "var(--font-mono)",
                            color: reference.selector ? "var(--text-muted)" : "var(--text-dim)",
                          }}
                        >
                          {reference.selector || t("roles.unset")}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                )}
                <SearchableSelect
                  value={row.model}
                  disabled={locked}
                  ariaLabel={row.name}
                  style={{ flex: "2 1 260px", minWidth: 160 }}
                  onChange={(value) => {
                    if (!value) {
                      onAssign(row.role, null);
                      return;
                    }
                    const supported = models.find((model) => model.selector === value)?.thinkingLevels;
                    const nextLevel = getModelRoleThinkingOptions(supported).includes(currentThinkingLevel)
                      ? currentThinkingLevel
                      : "inherit";
                    onAssign(row.role, formatModelRoleSelector(value, nextLevel));
                  }}
                  options={[
                    { value: "", label: t("roles.unset") },
                    ...models.map((model) => ({
                      value: model.selector,
                      label: `${model.name} — ${model.provider}`,
                      searchText: model.selector,
                    })),
                    ...row.model && !selected
                      ? [{ value: row.model, label: row.model }]
                      : [],
                  ]}
                />
              </div>

              {row.warning && (
                <span title={row.warning} style={{ color: "var(--warning, #ffb347)", fontSize: 12 }}>!</span>
              )}
            </div>

            {row.model && (
              <div style={{ paddingLeft: 72 }}>
                <ThinkingLevelStrip
                  label={t("roles.thinking")}
                  groupLabel={`${row.name} ${t("roles.thinking")}`}
                  levels={thinkingOptions}
                  value={currentThinkingLevel}
                  disabled={locked}
                  titleFor={(level) => level === "inherit" ? t("roles.thinkingInherit") : level}
                  onChange={(level) => onAssign(row.role, formatModelRoleSelector(row.model, level))}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A row of thinking-level buttons, one of them pressed. */
export function ThinkingLevelStrip<Level extends string>({
  label,
  groupLabel,
  levels,
  value,
  disabled,
  titleFor,
  labelFor = (level) => level,
  onChange,
}: {
  label: string;
  /** Names the group for assistive technology. */
  groupLabel: string;
  levels: readonly Level[];
  value: Level;
  disabled: boolean;
  titleFor?: (level: Level) => string;
  labelFor?: (level: Level) => string;
  onChange: (level: Level) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ color: "var(--text-dim)", fontSize: 10, whiteSpace: "nowrap" }}>{label}</span>
      <div
        role="group"
        aria-label={groupLabel}
        style={{
          display: "flex",
          flex: "1 1 auto",
          minWidth: 0,
          flexWrap: "wrap",
          gap: 3,
        }}
      >
        {levels.map((level) => {
          const active = value === level;
          return (
            <button
              key={level}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              title={titleFor?.(level) ?? level}
              onClick={() => {
                if (!active) onChange(level);
              }}
              style={{
                padding: "3px 7px",
                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 4,
                background: active ? "var(--bg-selected)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: active ? 700 : 500,
                lineHeight: 1.2,
                opacity: disabled ? 0.55 : 1,
              }}
            >
              {labelFor(level)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
