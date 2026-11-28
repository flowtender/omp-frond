"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  CHAT_CONTENT_WIDTH_DEFAULT,
  CHAT_CONTENT_WIDTH_MAX,
  CHAT_CONTENT_WIDTH_MIN,
  CHAT_CONTENT_FONT_SIZE_DEFAULT,
  CHAT_CONTENT_FONT_SIZE_MAX,
  CHAT_CONTENT_FONT_SIZE_MIN,
  useChatAppearance,
} from "@/hooks/useChatAppearance";
import {
  CHAT_ANIMATION_DURATION_MAX_MS, CHAT_ANIMATION_DURATION_MIN_MS,
  setChatAnimationDuration, setChatAnimations, useChatAnimationDuration, useChatAnimationsPreference,
} from "@/hooks/useChatAnimations";
import { useEnterSendMode, setEnterSendMode } from "@/hooks/useEnterSendMode";
import { useChatScrollMode, setChatScrollMode } from "@/hooks/useChatScrollMode";
import { useShowCostWithUsage, setShowCostWithUsage } from "@/hooks/useShowCostWithUsage";
import { setTokenDisplay, TOKEN_DISPLAY_MODES, useTokenDisplay } from "@/hooks/useTokenDisplay";
import { useFilesPlacement, setFilesPlacement } from "@/hooks/useFilesPlacement";
import { headerLanguageSwitch, headerThemeSwitch } from "@/hooks/useHeaderControls";
import { setPromptCacheIndicatorSettings, usePromptCacheIndicatorSettings } from "@/hooks/usePromptCacheIndicator";
import { MAX_INFERRED_CACHE_TIMEOUT_MINUTES, type PromptCacheIndicatorSource, type PromptCacheIndicatorStyle } from "@/lib/prompt-cache-shared";
import type { RuntimeSessionBinding } from "@/lib/agent-client";
import { useSessionReload } from "@/hooks/useSessionReload";
import type { ToolSettingsResponse } from "@/lib/api-types";
import { setExpansionPreference, useExpansionPreference, type ExpansionKind, type ExpansionMode } from "@/lib/expansion-preference";
import { setToolDisplayPreference, useToolDisplayPreference, type ToolDisplayPreference } from "@/hooks/useToolDisplayPreference";
import { setPythonFormatSettings, useInstalledPythonFormatters, usePythonFormatSettings } from "@/hooks/usePythonFormat";
import { PYTHON_FORMATTERS, type InstalledPythonFormatters, type PythonFormatterChoice } from "@/lib/python-format-shared";
import { setupPushSubscription } from "@/lib/push-client";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";
import { FontSettings } from "./FontSettings";

const PROMPT_CACHE_SOURCES: { value: PromptCacheIndicatorSource; label: string }[] = [
  { value: "off", label: "settings.promptCacheSourceOff" },
  { value: "live", label: "settings.promptCacheSourceLive" },
  { value: "inferred", label: "settings.promptCacheSourceInferred" },
];

const PROMPT_CACHE_STYLES: { value: PromptCacheIndicatorStyle; label: string }[] = [
  { value: "terminal", label: "settings.promptCacheStyleTerminal" },
  { value: "gradient", label: "settings.promptCacheStyleGradient" },
];

const EXPANSION_OPTIONS: { kind: ExpansionKind; label: string; modes: ExpansionMode[] }[] = [
  { kind: "thinking", label: "settings.expansionThinking", modes: ["collapsed", "expanded"] },
  { kind: "tools", label: "settings.expansionTools", modes: ["collapsed", "expanded", "failed"] },
  { kind: "process", label: "settings.expansionProcess", modes: ["automatic", "collapsed", "expanded"] },
  { kind: "compaction", label: "settings.expansionCompaction", modes: ["collapsed", "expanded"] },
];

function ExpansionSetting({ kind, label, modes }: typeof EXPANSION_OPTIONS[number]) {
  const { t } = useI18n();
  const value = useExpansionPreference(kind);
  return (
    <label className="settings-chat-option settings-chat-switch-option">
      <span>{t(label)}</span>
      <select
        value={value}
        onChange={(event) => setExpansionPreference(kind, event.target.value as ExpansionMode)}
        style={{ color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px" }}
      >
        {modes.map((mode) => <option key={mode} value={mode}>{t(`settings.expansionMode.${mode}`)}</option>)}
      </select>
    </label>
  );
}

function ToolDisplaySetting({ kind }: { kind: ToolDisplayPreference }) {
  const { t } = useI18n();
  const enabled = useToolDisplayPreference(kind);
  const label = t(`settings.toolDisplay.${kind}`);
  return <div className="settings-chat-option settings-chat-switch-option">
    <span>{label}</span>
    <ConfigSwitch checked={enabled} label={label} onChange={(next) => setToolDisplayPreference(kind, next)} />
  </div>;
}

function PythonFormatSetting({ installed }: { installed: InstalledPythonFormatters | null }) {
  const { t } = useI18n();
  const { enabled, formatter } = usePythonFormatSettings();
  const noneInstalled = installed !== null && !PYTHON_FORMATTERS.some((name) => installed[name]);
  const label = t("settings.pythonFormat");
  return <>
    <div className="settings-chat-option settings-chat-switch-option">
      <span>{label}</span>
      <ConfigSwitch
        checked={enabled}
        label={label}
        disabled={noneInstalled && !enabled}
        describedBy="settings-python-format-description"
        onChange={(next) => setPythonFormatSettings({ enabled: next })}
      />
    </div>
    <label className="settings-chat-option settings-chat-switch-option">
      <span>{t("settings.pythonFormatter")}</span>
      <select
        value={formatter}
        onChange={(event) => setPythonFormatSettings({ formatter: event.target.value as PythonFormatterChoice })}
        style={{ color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px" }}
      >
        <option value="auto">{t("settings.pythonFormatterAuto")}</option>
        {PYTHON_FORMATTERS.map((name) => (
          <option key={name} value={name} disabled={installed !== null && !installed[name]}>{name}</option>
        ))}
      </select>
    </label>
  </>;
}

interface UiSettingsProps {
  sessionId: string | null;
  runtimeId?: string;
  openingId?: string;
  onRuntimeIdentity?: RuntimeSessionBinding["onIdentity"];
  onReloaded?: (runtimeId: string | null) => void;
  quoteSelectionEnabled: boolean;
  onQuoteSelectionChange: (enabled: boolean) => void;
}

export function UiSettings({ sessionId, runtimeId, openingId, onRuntimeIdentity, onReloaded, quoteSelectionEnabled, onQuoteSelectionChange }: UiSettingsProps) {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const { width: chatContentWidth, setWidth: setChatContentWidth, fontSize, setFontSize } = useChatAppearance();
  const chatAnimations = useChatAnimationsPreference();
  const animationDuration = useChatAnimationDuration();
  const animationDurationLabel = new Intl.NumberFormat(locale, { style: "unit", unit: "second" }).format(animationDuration / 1000);
  const enterSendMode = useEnterSendMode();
  const chatScrollMode = useChatScrollMode();
  const showCostWithUsage = useShowCostWithUsage();
  const tokenDisplay = useTokenDisplay();
  const filesPlacement = useFilesPlacement();
  const showThemeSwitch = headerThemeSwitch.useVisible();
  const showLanguageSwitch = headerLanguageSwitch.useVisible();
  const promptCacheIndicator = usePromptCacheIndicatorSettings();
  const installedPythonFormatters = useInstalledPythonFormatters();
  const [shellSettings, setShellSettings] = useState<ToolSettingsResponse | null>(null);
  const [shellSaving, setShellSaving] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const sessionReload = useSessionReload({ sessionId, runtimeId, openingId, onRuntimeIdentity, onReloaded });
  const [pushRegistering, setPushRegistering] = useState(false);
  const [pushStatus, setPushStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/tools/settings")
      .then(async (response) => {
        const data = await response.json() as ToolSettingsResponse & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) setShellSettings(data);
      })
      .catch((cause) => {
        if (!cancelled) setShellError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, []);

  const togglePowerShell = async (enabled: boolean) => {
    setShellSaving(true);
    setShellError(null);
    try {
      const response = await fetch("/api/tools/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as ToolSettingsResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setShellSettings(data);
      await sessionReload.reload();
    } catch (cause) {
      setShellError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setShellSaving(false);
    }
  };

  const registerPush = async () => {
    if (pushRegistering) return;
    setPushRegistering(true);
    setPushStatus(null);
    try {
      if (typeof window === "undefined" || !("Notification" in window)) {
        throw new Error("unsupported or not permitted");
      }
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== "granted") throw new Error("unsupported or not permitted");
      const ok = await setupPushSubscription(locale);
      if (!ok) throw new Error("unsupported or not permitted");
      setPushStatus({ kind: "ok", message: t("settings.pushRegistered") });
    } catch (cause) {
      setPushStatus({ kind: "error", message: `${t("settings.pushRegisterFailed")} ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      setPushRegistering(false);
    }
  };

  return (
    <div className="settings-general">
      {sessionReload.dialog}
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.appearance")}</h3>
        <div className="settings-chat-options">
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.showHeaderThemeSwitch")}</span>
            <ConfigSwitch checked={showThemeSwitch} label={t("settings.showHeaderThemeSwitch")} onChange={headerThemeSwitch.setVisible} />
          </div>
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.showHeaderLanguageSwitch")}</span>
            <ConfigSwitch checked={showLanguageSwitch} label={t("settings.showHeaderLanguageSwitch")} onChange={headerLanguageSwitch.setVisible} />
          </div>
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.chatAnimations")}</span>
            <ConfigSwitch
              checked={chatAnimations}
              label={t("settings.chatAnimations")}
              describedBy="settings-chat-animations-description"
              onChange={setChatAnimations}
            />
          </div>
          <p id="settings-chat-animations-description" className="settings-general-description">{t("settings.chatAnimationsDescription")}</p>
          <div className="settings-chat-option settings-chat-range-option">
            <div className="settings-chat-range-header">
              <label htmlFor="settings-chat-animation-duration">{t("settings.chatAnimationDuration")}</label>
              <output htmlFor="settings-chat-animation-duration">{animationDurationLabel}</output>
            </div>
            <input
              id="settings-chat-animation-duration"
              type="range"
              min={CHAT_ANIMATION_DURATION_MIN_MS}
              max={CHAT_ANIMATION_DURATION_MAX_MS}
              step={100}
              value={animationDuration}
              aria-valuetext={animationDurationLabel}
              disabled={!chatAnimations}
              onChange={(event) => setChatAnimationDuration(event.currentTarget.valueAsNumber)}
            />
          </div>
          <div className="settings-chat-option settings-chat-switch-option" role="radiogroup" aria-label={t("settings.tokenDisplay")}>
            <span>{t("settings.tokenDisplay")}</span>
            <div className="settings-send-mode-options">
              {TOKEN_DISPLAY_MODES.map((mode) => (
                <label key={mode} className="settings-send-mode-option">
                  <input type="radio" name="token-display" value={mode} checked={tokenDisplay === mode} onChange={() => setTokenDisplay(mode)} className="sr-only" />
                  <span className="settings-send-mode-label">{t(`settings.tokenDisplay.${mode}`)}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="settings-chat-option settings-chat-switch-option" role="radiogroup" aria-label={t("settings.promptCacheSource")}>
            <span>{t("settings.promptCacheSource")}</span>
            <div className="settings-send-mode-options">
              {PROMPT_CACHE_SOURCES.map((option) => (
                <label key={option.value} className="settings-send-mode-option">
                  <input
                    type="radio"
                    name="prompt-cache-source"
                    value={option.value}
                    checked={promptCacheIndicator.source === option.value}
                    onChange={() => setPromptCacheIndicatorSettings({ source: option.value })}
                    className="sr-only"
                  />
                  <span className="settings-send-mode-label">{t(option.label)}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="settings-chat-option settings-chat-switch-option" role="radiogroup" aria-label={t("settings.promptCacheStyle")}>
            <span>{t("settings.promptCacheStyle")}</span>
            <div className="settings-send-mode-options">
              {PROMPT_CACHE_STYLES.map((option) => (
                <label key={option.value} className="settings-send-mode-option">
                  <input
                    type="radio"
                    name="prompt-cache-style"
                    value={option.value}
                    checked={promptCacheIndicator.style === option.value}
                    onChange={() => setPromptCacheIndicatorSettings({ style: option.value })}
                    className="sr-only"
                  />
                  <span className="settings-send-mode-label">{t(option.label)}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.promptCacheDistinguishInferred")}</span>
            <ConfigSwitch
              checked={promptCacheIndicator.distinguishInferred}
              label={t("settings.promptCacheDistinguishInferred")}
              describedBy="settings-prompt-cache-description"
              onChange={(distinguishInferred) => setPromptCacheIndicatorSettings({ distinguishInferred })}
            />
          </div>
          <label className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.promptCacheInferredTimeout")}</span>
            <input
              type="number"
              min={0}
              max={MAX_INFERRED_CACHE_TIMEOUT_MINUTES}
              value={promptCacheIndicator.inferredTimeoutMinutes || ""}
              placeholder={t("settings.promptCacheInferredTimeoutAuto")}
              aria-describedby="settings-prompt-cache-timeout-description"
              disabled={promptCacheIndicator.source === "off"}
              onChange={(event) => {
                const input = event.currentTarget;
                if (input.validity.valid) {
                  setPromptCacheIndicatorSettings({ inferredTimeoutMinutes: input.value === "" ? 0 : input.valueAsNumber });
                }
              }}
              style={{ color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", width: "7rem" }}
            />
          </label>
          <p id="settings-prompt-cache-timeout-description" className="settings-general-description">{t("settings.promptCacheInferredTimeoutDescription")}</p>
        </div>
        <p id="settings-prompt-cache-description" className="settings-general-description">{t("settings.promptCacheDescription")}</p>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.typography")}</h3>
        <p id="settings-typography-description" className="settings-general-description">{t("settings.fontDescription")}</p>
        <div className="settings-chat-options">
          <FontSettings />
          <div className="settings-chat-option settings-chat-range-option">
            <div className="settings-chat-range-header">
              <label htmlFor="settings-chat-content-font-size">{t("settings.chatContentFontSize")}</label>
              <output htmlFor="settings-chat-content-font-size">{fontSize}px</output>
              <ConfigButton
                variant="ghost"
                size="small"
                className="settings-chat-reset"
                title={t("settings.resetChatContentFontSize")}
                aria-label={t("settings.resetChatContentFontSize")}
                disabled={fontSize === CHAT_CONTENT_FONT_SIZE_DEFAULT}
                onClick={() => setFontSize(CHAT_CONTENT_FONT_SIZE_DEFAULT)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
                </svg>
              </ConfigButton>
            </div>
            <input
              id="settings-chat-content-font-size"
              type="range"
              min={CHAT_CONTENT_FONT_SIZE_MIN}
              max={CHAT_CONTENT_FONT_SIZE_MAX}
              step={1}
              value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))}
            />
          </div>
          <div className="settings-chat-option settings-chat-range-option">
            <div className="settings-chat-range-header">
              <label htmlFor="settings-chat-content-width">{t("settings.chatContentWidth")}</label>
              <output htmlFor="settings-chat-content-width">{chatContentWidth}px</output>
              <ConfigButton
                variant="ghost"
                size="small"
                className="settings-chat-reset"
                title={t("settings.resetChatContentWidth")}
                aria-label={t("settings.resetChatContentWidth")}
                disabled={chatContentWidth === CHAT_CONTENT_WIDTH_DEFAULT}
                onClick={() => setChatContentWidth(CHAT_CONTENT_WIDTH_DEFAULT)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
                </svg>
              </ConfigButton>
            </div>
            <input
              id="settings-chat-content-width"
              type="range"
              min={CHAT_CONTENT_WIDTH_MIN}
              max={CHAT_CONTENT_WIDTH_MAX}
              step={10}
              value={chatContentWidth}
              onChange={(event) => setChatContentWidth(Number(event.target.value))}
            />
          </div>
        </div>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.chat")}</h3>
        <div className="settings-chat-options">
          {EXPANSION_OPTIONS.map((option) => <ExpansionSetting key={option.kind} {...option} />)}
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.quoteSelection")}</span>
            <ConfigSwitch
              checked={quoteSelectionEnabled}
              label={t("settings.quoteSelection")}
              onChange={onQuoteSelectionChange}
            />
          </div>
          <div className="settings-chat-option settings-chat-switch-option" role="radiogroup" aria-label={t("settings.enterSendMode")}>
            <span>{t("settings.enterSendMode")}</span>
            <div className="settings-send-mode-options">
              <label className="settings-send-mode-option">
                <input
                  type="radio"
                  name="enter-send-mode"
                  value="enter"
                  checked={enterSendMode === "enter"}
                  onChange={() => setEnterSendMode("enter")}
                  className="sr-only"
                />
                <span className="settings-send-mode-label">{t("settings.enterSendModeEnter")}</span>
              </label>
              <label className="settings-send-mode-option">
                <input
                  type="radio"
                  name="enter-send-mode"
                  value="ctrlEnter"
                  checked={enterSendMode === "ctrlEnter"}
                  onChange={() => setEnterSendMode("ctrlEnter")}
                  className="sr-only"
                />
                <span className="settings-send-mode-label">{t("settings.enterSendModeCtrlEnter")}</span>
              </label>
            </div>
          </div>
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.chatScrollAnchor")}</span>
            <ConfigSwitch
              checked={chatScrollMode === "anchor"}
              label={t("settings.chatScrollAnchor")}
              describedBy="settings-chat-scroll-anchor-description"
              onChange={(enabled) => setChatScrollMode(enabled ? "anchor" : "follow")}
            />
          </div>
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.showCostWithUsage")}</span>
            <ConfigSwitch
              checked={showCostWithUsage}
              label={t("settings.showCostWithUsage")}
              describedBy="settings-show-cost-with-usage-description"
              onChange={setShowCostWithUsage}
            />
          </div>
        </div>
        <p id="settings-chat-scroll-anchor-description" className="settings-general-description">{t("settings.chatScrollAnchorDescription")}</p>
        <p id="settings-show-cost-with-usage-description" className="settings-general-description">{t("settings.showCostWithUsageDescription")}</p>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.toolDisplay")}</h3>
        <div className="settings-chat-options">
          <ToolDisplaySetting kind="compactJson" />
          <ToolDisplaySetting kind="readPreviews" />
          <PythonFormatSetting installed={installedPythonFormatters} />
        </div>
        <p className="settings-general-description">{t("settings.toolDisplayDescription")}</p>
        <p id="settings-python-format-description" className="settings-general-description">
          {installedPythonFormatters !== null && !PYTHON_FORMATTERS.some((name) => installedPythonFormatters[name])
            ? t("settings.pythonFormatNoneInstalled")
            : t("settings.pythonFormatDescription")}
        </p>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.sidebar")}</h3>
        <div className="settings-chat-options">
          <div
            className="settings-chat-option settings-chat-switch-option"
            role="radiogroup"
            aria-label={t("settings.filesPlacement")}
            aria-describedby="settings-files-placement-description"
          >
            <span>{t("settings.filesPlacement")}</span>
            <div className="settings-send-mode-options">
              <label className="settings-send-mode-option">
                <input
                  type="radio"
                  name="files-placement"
                  value="below"
                  checked={filesPlacement === "below"}
                  onChange={() => setFilesPlacement("below")}
                  className="sr-only"
                />
                <span className="settings-send-mode-label">{t("settings.filesPlacementBelow")}</span>
              </label>
              <label className="settings-send-mode-option">
                <input
                  type="radio"
                  name="files-placement"
                  value="tab"
                  checked={filesPlacement === "tab"}
                  onChange={() => setFilesPlacement("tab")}
                  className="sr-only"
                />
                <span className="settings-send-mode-label">{t("settings.filesPlacementTab")}</span>
              </label>
            </div>
          </div>
        </div>
        <p id="settings-files-placement-description" className="settings-general-description">{t("settings.filesPlacementDescription")}</p>
      </section>

      {shellSettings?.isWindows && (
        <section className="settings-general-section">
          <h3 className="settings-general-heading">{t("settings.shellTool")}</h3>
          <p className="settings-general-description">{t("settings.shellToolDescription")}</p>
          <div className="settings-shell-option">
            <span>{t("settings.usePowerShell")}</span>
            <ConfigSwitch
              checked={shellSettings.powerShellEnabled}
              loading={shellSaving}
              label={t("settings.usePowerShell")}
              onChange={(enabled) => void togglePowerShell(enabled)}
            />
          </div>
          {shellError && <p role="alert" className="settings-general-error">{shellError}</p>}
        </section>
      )}

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.pushPermission")}</h3>
        <p className="settings-general-description">{t("settings.pushPermissionDescription")}</p>
        <div className="settings-shell-option">
          <span>{t("settings.pushPermission")}</span>
          <button
            type="button"
            className="config-button config-button-small config-button-secondary"
            disabled={pushRegistering}
            onClick={() => void registerPush()}
          >
            {pushRegistering ? t("settings.pushRegisterLoading") : t("settings.pushRegister")}
          </button>
        </div>
        {pushStatus && (
          <p
            role="status"
            className="settings-general-error"
            style={pushStatus.kind === "ok" ? { color: "var(--accent)" } : undefined}
          >
            {pushStatus.message}
          </p>
        )}
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("common.language")}</h3>
        <div role="radiogroup" aria-label={t("common.language")} className="settings-language-options">
          {supportedLocales.map((plugin) => {
            const selected = locale === plugin.id;
            return (
              <button
                key={plugin.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setLocale(plugin.id as typeof locale)}
                className="settings-language-option"
              >
                <span className="settings-language-radio">
                  {selected && <span className="settings-language-radio-dot" />}
                </span>
                <span className="settings-language-label">{plugin.label}</span>
                <span className="settings-language-code">{plugin.id}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
