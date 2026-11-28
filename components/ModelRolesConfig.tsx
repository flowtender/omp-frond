"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type {
  ModelPresetActivateResponse,
  ModelPresetView,
  ModelPresetsResponse,
  ModelRoleAssignment,
  ModelRoleCandidate,
  ModelRoleModelRef,
  ModelRoleScope,
  ModelRoleSettingsResponse,
} from "@/lib/api-types";
import {
  formatModelRoleSelector,
  MODEL_PRESET_THINKING_LEVELS,
  toModelPresetThinkingLevel,
  type ModelPresetThinkingLevel,
} from "@/lib/model-role-selection";
import { useI18n } from "@/hooks/useI18n";
import type { TranslationParams } from "@/lib/i18n/types";
import { ModelRoleRows, ThinkingLevelStrip, type ModelRoleRow } from "./ModelRoleRows";
import { usePromptCacheLossDialog } from "./PromptCacheLossDialog";
import { PROMPT_CACHE_WARM_CODE, type PromptCacheLossWarning } from "@/lib/prompt-cache-shared";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigField,
  ConfigFooterStatus,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSaveTarget,
  ConfigScopeTag,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
} from "./SettingsUi";

type Selection = { type: "current" } | { type: "preset"; name: string } | { type: "new" };

type Translate = (key: string, params?: TranslationParams) => string;

const SCOPE_PATHS: Record<ModelRoleScope, string> = {
  global: "~/.omp/agent/config.yml",
  project: ".omp/config.yml",
};

/** Sidebar order of the layers a preset can come from. */
const PRESET_SOURCES: readonly ModelPresetView["source"][] = ["global", "project", "overlay", "runtime"];

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The scope switch with its label shown, since it governs a different write in each place. */
function RoleScopeTarget({ label, scope, projectAvailable, stacked = false, onChange }: {
  label: string;
  scope: ModelRoleScope;
  /** Without a project only the global config can be written. */
  projectAvailable: boolean;
  /** Label above the switch, for the narrow sidebar. */
  stacked?: boolean;
  onChange: (scope: ModelRoleScope) => void;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: stacked ? "column" : "row", alignItems: stacked ? "stretch" : "baseline", gap: stacked ? 4 : 8 }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{label}</span>
      <ConfigSaveTarget
        value={scope}
        label={label}
        path={SCOPE_PATHS[scope]}
        disabledReason={t("roles.projectNeedsCwd")}
        options={[
          { value: "global", label: t("roles.scopeGlobal") },
          { value: "project", label: t("roles.scopeProject"), disabled: !projectAvailable },
        ]}
        onChange={onChange}
      />
    </div>
  );
}

/** What omp runs a built-in role for; custom roles have no description. */
function describeRole(role: Pick<ModelRoleAssignment, "role" | "builtin">, t: Translate): string | undefined {
  return role.builtin ? t(`roles.describe.${role.role}`) : undefined;
}

const compactTokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

function modelLabel(model: ModelRoleModelRef): string {
  return model.name ?? model.modelId;
}

/**
 * What omp's own Models hub shows beside a role: the unset label naming the
 * fallback, and the detail lines (layers, built-in order, cycle, retry chain,
 * facts about the model it runs).
 */
function describeRoleStatus(
  role: ModelRoleAssignment,
  candidateCount: number,
  t: Translate,
): { unsetLabel?: string; details: string[] } {
  const { fallback, layers, facts } = role;
  const details: string[] = [];
  if (layers?.project && layers.global && layers.project !== layers.global) {
    details.push(t("roles.layers", { project: layers.project, global: layers.global }));
  }
  if (fallback && fallback.priorityChain.length > 0) {
    details.push(t("roles.priorityChain", { chain: fallback.priorityChain.join(", ") }));
  }
  if (role.cycleIndex) details.push(t("roles.cycle", { position: role.cycleIndex }));
  if (role.retryChain) details.push(t("roles.retryChain", { chain: role.retryChain.join(" → ") }));
  const modelFacts: string[] = [];
  if (facts?.compaction.tokens) {
    const tokens = compactTokens.format(facts.compaction.tokens);
    modelFacts.push(facts.compaction.basis
      ? t("roles.compaction", { tokens, basis: facts.compaction.basis })
      : t("roles.compactionTokens", { tokens }));
  }
  if (facts?.perf) {
    const tps = Math.round(facts.perf.tps);
    modelFacts.push(facts.perf.ttftMs === null
      ? t("roles.perfNoTtft", { tps })
      : t("roles.perf", { tps, ttft: (facts.perf.ttftMs / 1000).toFixed(1) }));
  }
  if (modelFacts.length > 0) details.push(modelFacts.join(" · "));
  if (candidateCount === 0) details.push(t("roles.noCandidates"));

  const unsetLabel = fallback?.model
    ? fallback.role
      ? t("roles.unsetDefaultsTo", { role: fallback.role, model: modelLabel(fallback.model) })
      : t("roles.unsetDefaultsToModel", { model: modelLabel(fallback.model) })
    : undefined;
  return { unsetLabel, details };
}

/** What a role is set to in the live setup, as a selector. */
function liveRoleSelector(role: ModelRoleAssignment | undefined): string {
  if (role?.selector) return role.selector;
  return role?.resolved ? `${role.resolved.provider}/${role.resolved.modelId}` : "";
}

/**
 * The roles omp's settings decide right now, edited in place: each pick is
 * written at once, to the layer the scope switch names.
 */
function CurrentRolesPane({ cwd, roles, candidates, onRolesSaved }: {
  cwd: string | null;
  roles: ModelRoleAssignment[];
  candidates: Record<string, ModelRoleCandidate[]>;
  onRolesSaved: (roles: ModelRoleAssignment[]) => void;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState<ModelRoleScope>("global");
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const assign = async (role: string, selector: string | null) => {
    setPendingRole(role);
    setError(null);
    try {
      const data = await readJson<{ roles: ModelRoleAssignment[] }>(
        await fetch("/api/model-roles", jsonRequest("PUT", { cwd: cwd ?? undefined, role, selector, scope })),
      );
      onRolesSaved(data.roles);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPendingRole(null);
    }
  };

  const rows = roles.filter((role) => !role.hidden).map((role): ModelRoleRow => {
    const { unsetLabel, details } = describeRoleStatus(role, candidates[role.role]?.length ?? 0, t);
    return {
      role: role.role,
      name: role.name,
      tag: role.tag,
      section: role.section,
      description: describeRole(role, t),
      details,
      unsetLabel,
      selector: role.selector,
      model: role.resolved ? `${role.resolved.provider}/${role.resolved.modelId}` : "",
      note: t(`roles.source.${role.source}`),
      warning: role.warning,
    };
  });

  return (
    <ConfigDetailStack>
      <div>
        <ConfigDetailTitle>{t("roles.current")}</ConfigDetailTitle>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 4 }}>
          {t("roles.description")}
        </div>
      </div>
      <RoleScopeTarget label={t("roles.scope")} scope={scope} projectAvailable={cwd !== null} onChange={setScope} />
      {error && <div role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}
      <ModelRoleRows rows={rows} candidates={candidates} pendingRole={pendingRole} onAssign={(role, selector) => void assign(role, selector)} />
    </ConfigDetailStack>
  );
}

function presetSourceLabel(source: ModelPresetView["source"], t: Translate): string {
  return t(`presets.source.${source}`);
}

interface PresetDraft {
  modelRoles: Record<string, string>;
  thinking: ModelPresetThinkingLevel;
}

function draftsEqual(a: PresetDraft, b: PresetDraft): boolean {
  const roles = new Set([...Object.keys(a.modelRoles), ...Object.keys(b.modelRoles)]);
  return a.thinking === b.thinking && [...roles].every((role) => a.modelRoles[role] === b.modelRoles[role]);
}

type ActivationReport =
  | { kind: "error"; message: string }
  /** `keptChat`: the user chose to leave the warm chat on its model. */
  | { kind: "done"; response: ModelPresetActivateResponse; keptChat: boolean };

/** The activate route's answer: done, or held back because the open chat's cache is warm. */
async function postActivation(body: Record<string, unknown>, openingId?: string): Promise<ModelPresetActivateResponse | { cacheLoss: PromptCacheLossWarning }> {
  const response = await fetch("/api/model-presets/activate", {
    ...jsonRequest("POST", body),
    headers: { "Content-Type": "application/json", ...(openingId ? { "X-OMP-Project-Opening": openingId } : {}) },
  });
  if (response.status === 428 && openingId) {
    window.dispatchEvent(new CustomEvent("omp-project-approval-required", { detail: openingId }));
  }
  const data = await response.json() as ModelPresetActivateResponse & { error?: string; code?: string; cacheLoss?: PromptCacheLossWarning };
  if (data.code === PROMPT_CACHE_WARM_CODE && data.cacheLoss) return { cacheLoss: data.cacheLoss };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function ActivationStatus({ name, report }: { name: string; report: ActivationReport }) {
  const { t } = useI18n();
  if (report.kind === "error") return <ConfigFooterStatus tone="error" summary={report.message} />;
  const { response } = report;
  const shadows = [
    ...response.shadowed.map((entry) => t("presets.shadowLine", {
      setting: entry.role,
      value: entry.actual ?? t("roles.unset"),
      source: entry.source,
    })),
    ...response.shadowedThinking
      ? [t("presets.shadowLine", {
        setting: "defaultThinkingLevel",
        value: response.shadowedThinking.actual ?? t("roles.unset"),
        source: response.shadowedThinking.source,
      })]
      : [],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <ConfigFooterStatus
        summary={response.live
          ? t("presets.activatedLive", { name, model: `${response.live.provider}/${response.live.modelId}` })
          : t(report.keptChat ? "presets.activatedKept" : "presets.activated", { name })}
      />
      {response.liveError && <ConfigFooterStatus tone="error" summary={t("presets.liveFailed", { error: response.liveError })} />}
      {shadows.length > 0 && (
        <ConfigFooterStatus tone="warning" summary={t("presets.shadowed", { count: shadows.length })} details={shadows} />
      )}
    </div>
  );
}

/**
 * One preset as an editable draft; Apply saves the draft into the preset.
 * Each role shows the preset's saved model and the live one beside its picker.
 * Activating happens from the preset list.
 */
function PresetPane({ cwd, preset, roles, candidates, activation, onDirtyChange, onPresetsSaved }: {
  cwd: string | null;
  preset: ModelPresetView;
  roles: ModelRoleAssignment[];
  candidates: Record<string, ModelRoleCandidate[]>;
  /** The outcome of this preset's last activation from the list. */
  activation: ActivationReport | null;
  /** The list's Activate waits for unsaved edits. */
  onDirtyChange: (name: string, dirty: boolean) => void;
  onPresetsSaved: (presets: ModelPresetView[], deleted?: boolean) => void;
}) {
  const { t } = useI18n();
  const saved = useMemo<PresetDraft>(() => ({
    modelRoles: { ...preset.modelRoles },
    thinking: toModelPresetThinkingLevel(preset.defaultThinkingLevel),
  }), [preset]);
  const [draft, setDraft] = useState<PresetDraft>(saved);
  const [busy, setBusy] = useState<"apply" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editable = preset.source === "global";
  const dirty = !draftsEqual(draft, saved);

  useEffect(() => {
    onDirtyChange(preset.name, dirty);
    return () => onDirtyChange(preset.name, false);
  }, [dirty, onDirtyChange, preset.name]);

  const liveRoles = new Map(roles.map((role) => [role.role, role]));
  const rows: ModelRoleRow[] = [
    ...roles.filter((role) => !role.hidden).map((role) => ({ role: role.role, name: role.name, tag: role.tag, section: role.section, description: describeRole(role, t) })),
    ...Object.keys(draft.modelRoles).filter((role) => !liveRoles.has(role)).map((role) => ({ role, name: role })),
  ].map((row) => {
    const selector = draft.modelRoles[row.role];
    const resolved = selector === preset.modelRoles[row.role] ? preset.resolved[row.role] : undefined;
    return {
      ...row,
      selector,
      model: selector ? resolved ?? formatModelRoleSelector(selector, "inherit") : "",
      references: [
        { label: t("presets.saved"), selector: preset.modelRoles[row.role] ?? "" },
        { label: t("presets.now"), selector: liveRoleSelector(liveRoles.get(row.role)) },
      ],
    };
  });

  const assign = (role: string, selector: string | null) => {
    setDraft((current) => {
      const modelRoles = { ...current.modelRoles };
      if (selector) modelRoles[role] = selector;
      else delete modelRoles[role];
      return { ...current, modelRoles };
    });
  };

  const run = async (action: NonNullable<typeof busy>, request: () => Promise<void>) => {
    setBusy(action);
    setError(null);
    try {
      await request();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const apply = () => run("apply", async () => {
    const data = await readJson<ModelPresetsResponse>(await fetch("/api/model-presets", jsonRequest("PUT", {
      cwd: cwd ?? undefined,
      name: preset.name,
      modelRoles: draft.modelRoles,
      ...draft.thinking === "keep" ? {} : { defaultThinkingLevel: draft.thinking },
    })));
    onPresetsSaved(data.presets);
  });

  const remove = () => run("delete", async () => {
    const query = new URLSearchParams({ name: preset.name, ...cwd ? { cwd } : {} });
    const data = await readJson<ModelPresetsResponse>(await fetch(`/api/model-presets?${query}`, { method: "DELETE" }));
    onPresetsSaved(data.presets, true);
  });

  const headingNote = preset.invalid
    ? t("presets.invalid", { reason: preset.invalid })
    : !editable
      ? t("presets.readOnly", { source: presetSourceLabel(preset.source, t) })
      : dirty
        ? t("presets.unsaved")
        : null;

  return (
    <ConfigDetailStack>
      <div className="config-detail-heading">
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <ConfigScopeTag scope={preset.source}>{presetSourceLabel(preset.source, t)}</ConfigScopeTag>
            <ConfigDetailTitle>{preset.name}</ConfigDetailTitle>
            {preset.active && <span style={{ fontSize: 10, color: "var(--success)" }}>{t("presets.active")}</span>}
          </ConfigDetailHeaderInfo>
          {editable && (
            <ConfigDetailActions>
              <ConfigButton variant="primary" size="small" disabled={!dirty || busy !== null} onClick={() => void apply()}>
                {busy === "apply" ? t("i18n.saving") : t("presets.apply")}
              </ConfigButton>
              <ConfigButton variant="danger" size="small" disabled={busy !== null} onClick={() => void remove()}>
                {busy === "delete" ? t("i18n.removing") : t("i18n.delete")}
              </ConfigButton>
            </ConfigDetailActions>
          )}
        </ConfigDetailHeader>
        {headingNote && <div className="config-detail-heading-note">{headingNote}</div>}
      </div>

      {error && <ConfigFooterStatus tone="error" summary={error} />}
      {activation && <ActivationStatus name={preset.name} report={activation} />}

      <ThinkingLevelStrip
        label={t("presets.thinking")}
        groupLabel={t("presets.thinking")}
        levels={MODEL_PRESET_THINKING_LEVELS}
        value={draft.thinking}
        disabled={!editable || busy !== null}
        labelFor={(level) => level === "keep" ? t("presets.thinkingKeep") : level}
        titleFor={(level) => level === "keep" ? t("presets.thinkingKeepTitle") : level}
        onChange={(thinking) => setDraft((current) => ({ ...current, thinking }))}
      />
      <ModelRoleRows rows={rows} candidates={candidates} disabled={!editable || busy !== null} onAssign={assign} />
    </ConfigDetailStack>
  );
}

function NewPresetPane({ cwd, onCreated }: { cwd: string | null; onCreated: (name: string, presets: ModelPresetView[]) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const data = await readJson<ModelPresetsResponse>(
        await fetch("/api/model-presets", jsonRequest("POST", { cwd: cwd ?? undefined, name: trimmed })),
      );
      onCreated(trimmed, data.presets);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfigDetailStack>
      <div>
        <ConfigDetailTitle>{t("presets.new")}</ConfigDetailTitle>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 4 }}>
          {t("presets.newDescription", { path: SCOPE_PATHS.global })}
        </div>
      </div>
      <ConfigField label={t("presets.name")}>
        <input
          className="config-add-source-input"
          value={name}
          aria-label={t("presets.name")}
          placeholder="fast-and-cheap"
          aria-describedby={hintId}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void create(); }}
        />
        <span id={hintId} style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("presets.nameHint")}</span>
      </ConfigField>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ConfigButton variant="primary" disabled={!name.trim() || saving} onClick={() => void create()}>
          {saving ? t("i18n.saving") : t("presets.create")}
        </ConfigButton>
        {error && <ConfigFooterStatus tone="error" summary={error} />}
      </div>
    </ConfigDetailStack>
  );
}

/**
 * Settings › Model roles: the live role setup and omp's model presets
 * (`modelPresets`), listed like the Models tab lists providers. Without a
 * project only the global config is read and written.
 */
export function ModelRolesConfig({ cwd, session, openingId, onClose, onRolesChanged }: {
  cwd: string | null;
  /** The open chat (its runtime id while it has one), switched when a preset is activated. */
  session: string | null;
  openingId?: string;
  onClose: () => void;
  /** Open chats re-read their role table. */
  onRolesChanged: () => void;
}) {
  const { t } = useI18n();
  const [roles, setRoles] = useState<ModelRoleAssignment[]>([]);
  const [candidates, setCandidates] = useState<Record<string, ModelRoleCandidate[]>>({});
  const [presets, setPresets] = useState<ModelPresetView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activateScope, setActivateScope] = useState<ModelRoleScope>("global");
  const [selection, setSelection] = useState<Selection>({ type: "current" });
  /** The preset whose draft has unsaved edits; its Activate waits for Apply. */
  const [dirtyPreset, setDirtyPreset] = useState<string | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [activation, setActivation] = useState<{ name: string; report: ActivationReport } | null>(null);
  const cacheLoss = usePromptCacheLossDialog();
  const cwdQuery = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";

  const loadPresets = useCallback(async (signal?: AbortSignal) => {
    const data = await readJson<ModelPresetsResponse>(await fetch(`/api/model-presets${cwdQuery}`, { signal }));
    setPresets(data.presets);
  }, [cwdQuery]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    Promise.all([
      fetch(`/api/model-roles${cwdQuery}`, { signal: controller.signal })
        .then((response) => readJson<ModelRoleSettingsResponse>(response))
        .then((data) => {
          setRoles(data.roles);
          setCandidates(data.candidates);
        }),
      loadPresets(controller.signal),
    ])
      .catch((caught: unknown) => {
        if ((caught as Error).name !== "AbortError") setLoadError(errorText(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cwdQuery, loadPresets]);

  const markDirty = useCallback((name: string, dirty: boolean) => {
    setDirtyPreset((current) => dirty ? name : current === name ? null : current);
  }, []);

  const rolesSaved = (next: ModelRoleAssignment[]) => {
    setRoles(next);
    onRolesChanged();
    // Which preset the setup matches may have changed.
    loadPresets().catch((caught: unknown) => setLoadError(errorText(caught)));
  };

  const activate = async (name: string) => {
    setSelection({ type: "preset", name });
    setActivating(name);
    setActivation(null);
    try {
      const request = { cwd: cwd ?? undefined, name, scope: activateScope, session: session ?? undefined };
      let result = await postActivation(request, openingId);
      let keptChat = false;
      if ("cacheLoss" in result) {
        const choice = await cacheLoss.ask(result.cacheLoss, {
          confirmLabel: t("presets.switchChat"),
          alternateLabel: t("presets.newChatsOnly"),
        });
        if (choice === "cancel") return;
        keptChat = choice === "alternate";
        result = await postActivation({ ...request, liveSwitch: keptChat ? "skip" : "switch" }, openingId);
        if ("cacheLoss" in result) throw new Error("The activation was held back again");
      }
      setActivation({ name, report: { kind: "done", response: result, keptChat } });
      setPresets(result.presets);
      setRoles(result.roles);
      onRolesChanged();
    } catch (caught) {
      setActivation({ name, report: { kind: "error", message: errorText(caught) } });
    } finally {
      setActivating(null);
    }
  };

  const selectedPreset = selection.type === "preset"
    ? presets.find((preset) => preset.name === selection.name)
    : undefined;
  const presetGroups = PRESET_SOURCES
    .map((source) => ({ source, presets: presets.filter((preset) => preset.source === source) }))
    .filter((group) => group.presets.length > 0);

  const detail = (() => {
    if (loading) return null;
    if (selection.type === "new") {
      return (
        <NewPresetPane
          cwd={cwd}
          onCreated={(name, next) => {
            setPresets(next);
            setSelection({ type: "preset", name });
          }}
        />
      );
    }
    if (selectedPreset) {
      return (
        <PresetPane
          key={`${selectedPreset.name}\n${JSON.stringify([selectedPreset.modelRoles, selectedPreset.defaultThinkingLevel])}`}
          cwd={cwd}
          preset={selectedPreset}
          roles={roles}
          candidates={candidates}
          activation={activation?.name === selectedPreset.name ? activation.report : null}
          onDirtyChange={markDirty}
          onPresetsSaved={(next, deleted) => {
            setPresets(next);
            if (deleted) setSelection({ type: "current" });
          }}
        />
      );
    }
    return <CurrentRolesPane cwd={cwd} roles={roles} candidates={candidates} onRolesSaved={rolesSaved} />;
  })();

  return (
    <ConfigPanelShell embedded title={t("roles.title")} closeLabel={t("i18n.close")} onClose={onClose}>
      {cacheLoss.dialog}
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            <ConfigSidebarItem
              active={selection.type === "current" || (selection.type === "preset" && !selectedPreset)}
              onClick={() => setSelection({ type: "current" })}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-muted)", flexShrink: 0 }}>
                <line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2.2" />
                <line x1="4" y1="17" x2="20" y2="17" /><circle cx="15" cy="17" r="2.2" />
              </svg>
              <ConfigSidebarText className="is-grow">{t("roles.current")}</ConfigSidebarText>
            </ConfigSidebarItem>
            <div className="config-sidebar-group">
              <ConfigSidebarGroupLabel>{t("roles.presets")}</ConfigSidebarGroupLabel>
              <div style={{ padding: "2px 8px 8px" }}>
                <RoleScopeTarget
                  label={t("presets.activateInto")}
                  scope={activateScope}
                  projectAvailable={cwd !== null}
                  stacked
                  onChange={setActivateScope}
                />
              </div>
              {loading ? (
                <div className="config-sidebar-message">{t("i18n.loading")}</div>
              ) : loadError ? (
                <div className="config-sidebar-message is-error">{loadError}</div>
              ) : presetGroups.length === 0 ? (
                <div className="config-sidebar-message is-empty">{t("roles.noPresets")}</div>
              ) : presetGroups.map((group, index) => (
                <div key={group.source}>
                  {index > 0 && <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />}
                  <ConfigSidebarGroupLabel>{t(`presets.group.${group.source}`)}</ConfigSidebarGroupLabel>
                  {group.presets.map((preset) => {
                    const canActivate = activating === null && !preset.active && !preset.invalid && dirtyPreset !== preset.name;
                    return (
                      <div key={preset.name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <ConfigSidebarItem
                          active={selection.type === "preset" && selection.name === preset.name}
                          title={preset.active ? `${preset.name} · ${t("presets.active")}` : preset.name}
                          style={{ flex: 1 }}
                          onClick={() => setSelection({ type: "preset", name: preset.name })}
                        >
                          <ConfigStatusDot active={preset.active} />
                          <ConfigSidebarText className="is-grow">{preset.name}</ConfigSidebarText>
                        </ConfigSidebarItem>
                        <ConfigButton
                          size="small"
                          variant={canActivate ? "primary" : "secondary"}
                          disabled={!canActivate}
                          aria-label={t("presets.activateNamed", { name: preset.name })}
                          onClick={() => void activate(preset.name)}
                        >
                          {activating === preset.name ? t("presets.activating") : t("presets.activate")}
                        </ConfigButton>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </ConfigSidebarList>
          <ConfigListAction active={selection.type === "new"} onClick={() => setSelection({ type: "new" })}>
            {t("roles.savePreset")}
          </ConfigListAction>
        </ConfigSidebar>
        <ConfigDetail>{detail}</ConfigDetail>
      </ConfigSplitView>
    </ConfigPanelShell>
  );
}
