"use client";

import { useRef, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { describeProjectChoices, type ProjectChoice } from "@/lib/new-session-context";
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "./SidebarMenu";
import { ChevronIcon, FolderIcon } from "./SidebarIcons";
import styles from "./SettingsConfig.module.css";

interface Props {
  projects: readonly ProjectChoice[];
  /** Null: the global settings. */
  value: ProjectChoice | null;
  /** By project root, the settings that project's own config sets on this page. */
  overrides: Readonly<Record<string, readonly string[]>>;
  onChange: (project: ProjectChoice | null) => void;
}

function overrideBadge(count: number) {
  return <span className={styles.scopeOverrideBadge}>{count} custom</span>;
}

/**
 * "Edit for": the global settings, or one project's own. Projects are the
 * ones the new-chat picker lists; a project whose config differs from the
 * global settings on this page shows how many settings it sets.
 */
export function SettingsScopePicker({ projects, value, overrides, onChange }: Props) {
  const mobile = useIsMobile();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<SidebarMenuAnchor | null>(null);
  const [width, setWidth] = useState(260);
  const described = describeProjectChoices(projects);
  const selected = value ? described.find(({ choice }) => choice.key === value.key) : undefined;
  const selectedOverrides = value ? overrides[value.root]?.length ?? 0 : 0;

  const items: SidebarMenuItem[] = [
    { type: "item", id: "global", label: "Global (all projects)", checked: value === null, onSelect: () => onChange(null) },
    ...(described.length > 0 ? [{ type: "separator", id: "separator" } as const] : []),
    ...described.map(({ choice, name, note }): SidebarMenuItem => {
      const count = overrides[choice.root]?.length ?? 0;
      return {
        type: "item",
        id: `project:${choice.key}`,
        label: name,
        note: note ?? undefined,
        title: choice.root,
        mono: true,
        checked: choice.key === value?.key,
        badge: count > 0 ? overrideBadge(count) : undefined,
        onSelect: () => onChange(choice),
      };
    }),
  ];

  return (
    <div className={styles.scopeBar}>
      <span className={styles.scopeLabel}>Edit for</span>
      <div className="project-picker is-inline" role="group" aria-label="Edit settings for">
        <button
          ref={buttonRef}
          type="button"
          className="project-picker-button is-project"
          data-overridden={selectedOverrides > 0}
          title={value?.root ?? "Global settings, ~/.omp/agent/config.yml"}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setWidth(Math.max(260, Math.round(rect.width)));
            setAnchor({ kind: "rect", rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, align: "start" });
          }}
        >
          <FolderIcon size={12} className="project-picker-icon" />
          <span className="project-picker-name">
            {selected?.note && <><span className="project-picker-parent">{selected.note}</span>/</>}
            <span className="project-picker-leaf">{value ? selected?.name ?? value.root : "Global"}</span>
          </span>
          {selectedOverrides > 0 && overrideBadge(selectedOverrides)}
          <ChevronIcon size={9} className="project-picker-chevron sidebar-icon-down" />
        </button>
      </div>
      <SidebarMenu
        open={anchor !== null}
        anchor={anchor}
        sheet={mobile}
        ariaLabel="Edit settings for"
        title="Edit settings for"
        items={items}
        filter={{ placeholder: "Filter projects", emptyLabel: "No matching projects" }}
        cancelLabel="Cancel"
        onClose={() => setAnchor(null)}
        returnFocusTo={buttonRef.current}
        width={width}
        overDialog
      />
    </div>
  );
}
