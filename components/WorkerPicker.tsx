"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { WorkerSummary } from "@/lib/worker-control";
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "./SidebarMenu";
import { ChevronIcon, PlusIcon, RefreshIcon, SpinnerIcon, TerminalIcon } from "./SidebarIcons";

type Panel =
  | { kind: "select" }
  /** The worker is mid-run: restarting it needs a second, forced request. */
  | { kind: "busy" }
  | { kind: "failed"; message: string };

interface MenuState {
  panel: Panel;
  anchor: SidebarMenuAnchor;
  opener: HTMLElement;
  width: number;
}

// The bar mounts again with every move of the fresh composer: the list found
// once seeds the next mount, so the picker does not blink out meanwhile.
let workersFound: WorkerSummary[] | null = null;

async function loadWorkers(): Promise<WorkerSummary[] | null> {
  try {
    const response = await fetch("/api/workers", { cache: "no-store" });
    if (!response.ok) return null;
    const { workers } = await response.json() as { workers: WorkerSummary[] };
    workersFound = workers;
    return workers;
  } catch {
    return null;
  }
}

/** Why a restart did not happen, from the route's JSON body. */
async function errorOf(response: Response): Promise<string | null> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? null;
}

interface Props {
  /** A phone: the menus open as bottom sheets. */
  mobile: boolean;
}

/**
 * The worker a fresh composer's session runs on, and the button that starts
 * or restarts it (to pick up changed tools or a rebuilt worker). Beside the
 * project and worktree buttons in the new-session bar. A restart that would
 * interrupt a run asks first; an idle worker restarts at once.
 */
export function WorkerPicker({ mobile }: Props) {
  const { t } = useI18n();
  const [workers, setWorkers] = useState(() => workersFound);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [restarting, setRestarting] = useState(false);
  const restartButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);

  const refresh = useCallback(async () => {
    const found = await loadWorkers();
    if (found && mountedRef.current) setWorkers(found);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  if (!workers || workers.length === 0) return null;

  const selected = workers.find((worker) => worker.id === selectedId) ?? workers[0];
  const workerName = (worker: WorkerSummary) => worker.id === "local" ? t("worker.local") : worker.id;
  const stopped = selected.state === "stopped";

  const openMenu = (panel: Panel, opener: HTMLElement, minWidth: number) => {
    const rect = opener.getBoundingClientRect();
    setMenu({
      panel,
      anchor: { kind: "rect", rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, align: "start" },
      opener,
      width: Math.max(minWidth, Math.round(rect.width)),
    });
  };

  const restart = async (force: boolean) => {
    const opener = restartButtonRef.current;
    if (!opener || restarting || !selected.managed) return;
    setMenu(null);
    setRestarting(true);
    let failure: string | null = null;
    try {
      const response = await fetch(`/api/workers/${encodeURIComponent(selected.id)}/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      if (response.status === 409 && (await response.clone().json().catch(() => null))?.busy) {
        if (mountedRef.current) openMenu({ kind: "busy" }, opener, 260);
        return;
      }
      if (!response.ok) failure = await errorOf(response) ?? t("worker.restartFailed");
    } catch (error) {
      failure = error instanceof Error ? error.message : t("worker.restartFailed");
    } finally {
      if (mountedRef.current) setRestarting(false);
    }
    if (failure !== null && mountedRef.current) openMenu({ kind: "failed", message: failure }, opener, 260);
    await refresh();
  };

  const closeMenu = () => setMenu(null);

  const selectItems = (): SidebarMenuItem[] => [
    ...workers.map((worker): SidebarMenuItem => ({
      type: "item",
      id: `worker:${worker.id}`,
      label: workerName(worker),
      note: worker.state === "stopped" ? t("worker.stopped") : undefined,
      checked: worker.id === selected.id,
      onSelect: () => setSelectedId(worker.id),
    })),
    { type: "separator", id: "separator" },
    {
      type: "item",
      id: "another-local-worker",
      label: t("worker.another"),
      icon: <PlusIcon size={13} />,
      disabled: true,
      disabledReason: t("worker.notYet"),
      onSelect: () => {},
    },
  ];

  const busyBody = (
    <div className="sidebar-worktree-form">
      {!mobile && <div className="sidebar-menu-header">{t("worker.restartBusyTitle")}</div>}
      <div className="sidebar-worktree-message">{t("worker.restartBusy")}</div>
      <div className="sidebar-worktree-form-buttons">
        <button type="button" className="sidebar-worktree-force" onClick={() => { void restart(true); }}>
          {t("worker.restartAnyway")}
        </button>
        <button type="button" className="sidebar-worktree-cancel" data-sidebar-menu-autofocus="" onClick={closeMenu}>
          {t("sidebar.cancel")}
        </button>
      </div>
    </div>
  );

  const failedBody = menu?.panel.kind === "failed" ? (
    <div className="sidebar-worktree-form">
      <div className="sidebar-worktree-error" role="alert">{menu.panel.message}</div>
      <div className="sidebar-worktree-form-buttons">
        <button type="button" className="sidebar-worktree-cancel" data-sidebar-menu-autofocus="" onClick={closeMenu}>
          {t("sidebar.cancel")}
        </button>
      </div>
    </div>
  ) : null;

  const panel = menu?.panel.kind;
  const menuTitle = panel === "select" ? t("worker.select") : panel === "busy" ? t("worker.restartBusyTitle") : t("worker.restartFailed");
  const restartLabel = !selected.managed ? t("worker.notManaged") : stopped ? t("worker.start") : t("worker.restart");

  return (
    <div className="project-picker is-inline worker-picker" role="group" aria-label={t("worker.group")}>
      <button
        type="button"
        className="project-picker-button is-project"
        title={t("worker.select")}
        aria-haspopup="menu"
        aria-expanded={panel === "select"}
        onClick={(event) => openMenu({ kind: "select" }, event.currentTarget, 240)}
      >
        <TerminalIcon size={12} className="project-picker-icon" />
        <span className="project-picker-name">
          <span className="project-picker-leaf">{workerName(selected)}</span>
        </span>
        {stopped && <span className="worker-picker-state">{t("worker.stopped")}</span>}
        <ChevronIcon size={9} className="project-picker-chevron sidebar-icon-down" />
      </button>
      <button
        ref={restartButtonRef}
        type="button"
        className="project-picker-button is-icon"
        title={restartLabel}
        aria-label={restartLabel}
        aria-disabled={restarting || !selected.managed ? true : undefined}
        aria-haspopup={panel === "busy" ? "dialog" : undefined}
        onClick={() => { void restart(false); }}
      >
        {restarting ? <SpinnerIcon size={12} className="project-picker-icon" /> : <RefreshIcon size={12} className="project-picker-icon" />}
      </button>
      <SidebarMenu
        open={menu !== null}
        anchor={menu?.anchor ?? null}
        sheet={mobile}
        ariaLabel={menuTitle}
        title={menuTitle}
        items={panel === "select" ? selectItems() : undefined}
        cancelLabel={t("sidebar.cancel")}
        focusCancel={panel === "busy"}
        onClose={closeMenu}
        returnFocusTo={menu?.opener ?? null}
        width={menu?.width}
        classic={!mobile}
      >
        {panel === "busy" ? busyBody : failedBody}
      </SidebarMenu>
    </div>
  );
}
