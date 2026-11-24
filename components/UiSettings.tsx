"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { THEME_OPTIONS } from "@/lib/theme";
import {
  CHAT_CONTENT_WIDTH_DEFAULT,
  CHAT_CONTENT_WIDTH_MAX,
  CHAT_CONTENT_WIDTH_MIN,
  CHAT_CONTENT_FONT_SIZE_DEFAULT,
  CHAT_CONTENT_FONT_SIZE_MAX,
  CHAT_CONTENT_FONT_SIZE_MIN,
  useChatAppearance,
} from "@/hooks/useChatAppearance";
import { useEnterSendMode, setEnterSendMode } from "@/hooks/useEnterSendMode";
import { useChatScrollMode, setChatScrollMode } from "@/hooks/useChatScrollMode";
import { useShowCostWithUsage, setShowCostWithUsage } from "@/hooks/useShowCostWithUsage";
import { useFilesPlacement, setFilesPlacement } from "@/hooks/useFilesPlacement";
import { setPromptCacheIndicatorSettings, usePromptCacheIndicatorSettings } from "@/hooks/usePromptCacheIndicator";
import type { PromptCacheIndicatorSource, PromptCacheIndicatorStyle } from "@/lib/prompt-cache-shared";
import { sendAgentCommand, type RuntimeSessionBinding } from "@/lib/agent-client";
import type { ToolSettingsResponse } from "@/lib/api-types";
import {
  isThinkingExpandedByDefault,
  setThinkingExpandedByDefault,
} from "@/lib/thinking-expansion-preference";
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

interface UiSettingsProps {
  sessionId: string | null;
  runtimeId?: string;
  onRuntimeIdentity?: RuntimeSessionBinding["onIdentity"];
  onReloaded?: (runtimeId: string | null) => void;
  quoteSelectionEnabled: boolean;
  onQuoteSelectionChange: (enabled: boolean) => void;
}

export function UiSettings({ sessionId, runtimeId, onRuntimeIdentity, onReloaded, quoteSelectionEnabled, onQuoteSelectionChange }: UiSettingsProps) {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const { width: chatContentWidth, setWidth: setChatContentWidth, fontSize, setFontSize } = useChatAppearance();
  const enterSendMode = useEnterSendMode();
  const chatScrollMode = useChatScrollMode();
  const showCostWithUsage = useShowCostWithUsage();
  const filesPlacement = useFilesPlacement();
  const promptCacheIndicator = usePromptCacheIndicatorSettings();
  const [shellSettings, setShellSettings] = useState<ToolSettingsResponse | null>(null);
  const [shellSaving, setShellSaving] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [cacheMissNotices, setCacheMissNotices] = useState<boolean | null>(null);
  const [cacheMissNoticesSaving, setCacheMissNoticesSaving] = useState(false);
  const [cacheMissNoticesError, setCacheMissNoticesError] = useState<string | null>(null);
  const [pushRegistering, setPushRegistering] = useState(false);
  const [pushStatus, setPushStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  useEffect(() => {
    setThinkingExpanded(isThinkingExpandedByDefault());
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/cache-miss-notices")
      .then(async (response) => {
        const data = await response.json() as { enabled?: boolean; error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) setCacheMissNotices(data.enabled === true);
      })
      .catch((cause) => {
        if (!cancelled) setCacheMissNoticesError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, []);

  // pi's showCacheMissNotices (#1265); the open chat is read again to show or drop them.
  const toggleCacheMissNotices = async (enabled: boolean) => {
    setCacheMissNoticesSaving(true);
    setCacheMissNoticesError(null);
    try {
      const response = await fetch("/api/cache-miss-notices", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as { enabled?: boolean; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setCacheMissNotices(data.enabled === true);
      if (sessionId) onReloaded?.(runtimeId ?? null);
    } catch (cause) {
      setCacheMissNoticesError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCacheMissNoticesSaving(false);
    }
  };

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
      if (sessionId) {
        const binding = { current: runtimeId ?? null, onIdentity: onRuntimeIdentity };
        await sendAgentCommand(sessionId, { type: "reload" }, binding);
        onReloaded?.(binding.current);
      }
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
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.appearance")}</h3>
        <div role="radiogroup" aria-label={t("settings.appearance")} className="settings-theme-options">
          {THEME_OPTIONS.map((option) => {
            const selected = preference === option.id;
            return (
              <label
                key={option.id}
                className="settings-theme-option"
                data-system={option.id === "auto" || undefined}
                data-wide={option.id === "contrast-light" || option.id === "contrast-dark" || option.id === "zenburn" || undefined}
              >
                <input
                  type="radio"
                  name="theme"
                  value={option.id}
                  checked={selected}
                  onChange={() => setThemePreference(option.id)}
                  className="sr-only"
                />
                {/* A data-theme span paints with that theme's own variables. System is a switch, not a
                    palette: a neutral tile with a light and a dark chip beside its name. */}
                {option.id === "auto" ? (
                  <span className="settings-theme-swatch settings-theme-system" aria-hidden="true">
                    <span data-theme="light" className="settings-theme-chip" />
                    <span data-theme="dark" className="settings-theme-chip" />
                    <span className="settings-theme-system-name">{t(option.label)}</span>
                  </span>
                ) : (
                  <span className="settings-theme-swatch" aria-hidden="true">
                    <span data-theme={option.id} className="settings-theme-fill">
                      <span className="settings-theme-name">{t(option.label)}</span>
                    </span>
                  </span>
                )}
                <span className="sr-only">{t(option.label)}</span>
              </label>
            );
          })}
        </div>
        <div className="settings-chat-options">
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
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.thinkingExpandedDefault")}</span>
            <ConfigSwitch
              checked={thinkingExpanded}
              label={t("settings.thinkingExpandedDefault")}
              onChange={(enabled) => {
                setThinkingExpandedByDefault(enabled);
                setThinkingExpanded(enabled);
              }}
            />
          </div>
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
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.cacheMissNotices")}</span>
            <ConfigSwitch
              checked={cacheMissNotices === true}
              loading={(cacheMissNotices === null && !cacheMissNoticesError) || cacheMissNoticesSaving}
              label={t("settings.cacheMissNotices")}
              describedBy="settings-cache-miss-notices-description"
              onChange={(enabled) => void toggleCacheMissNotices(enabled)}
            />
          </div>
        </div>
        <p id="settings-chat-scroll-anchor-description" className="settings-general-description">{t("settings.chatScrollAnchorDescription")}</p>
        <p id="settings-show-cost-with-usage-description" className="settings-general-description">{t("settings.showCostWithUsageDescription")}</p>
        <p id="settings-cache-miss-notices-description" className="settings-general-description">{t("settings.cacheMissNoticesDescription")}</p>
        {cacheMissNoticesError && <p role="alert" className="settings-general-error">{cacheMissNoticesError}</p>}
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
