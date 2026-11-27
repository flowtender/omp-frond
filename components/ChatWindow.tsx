"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentMessage, AgentUsage, AssistantContentBlock, AssistantMessage, BackgroundJob, BashExecutionMessage, BlockingExtensionUiRequest, ExtensionUiRequest, SessionInfo, SessionTreeNode, SubagentSnapshot, ToolResultMessage } from "@/lib/types";
import { normalizeCustomPanelLines } from "@/lib/ansi";
import { splitNoticeText } from "@/lib/notice-text";
import { EXTENSION_DIALOG_BASE_WIDTH, fitExtensionDialogWidth } from "@/lib/extension-dialog-fit";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { isMessageGroupAnchor, type DisplayOptions } from "@/lib/message-display";
import { buildChatTranscript, type ChatTranscriptItem } from "@/lib/chat-transcript";
import { useExpansionPreference } from "@/lib/expansion-preference";
import { toolCallFailureCount } from "@/lib/tool-call-expansion";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { attachDeferredTaskResults } from "@/lib/task-tool-display";
import { formatTurnDuration, getTurnDurationMs } from "@/lib/turn-duration";
import { buildQuotedSelection } from "@/lib/quoted-selection";
import { dropMentionText, splitDroppedItems, uploadFiles, type DroppedItem } from "@/lib/file-upload-client";
import { formatTime, formatUsage, getModelDisplayName, handoffTimeOf, MessageView, TranscriptToolResult } from "./MessageView";
import { TranscriptViewportRow } from "./TranscriptViewportRow";
import { FoldTokenTotals, TokenFlow, TokenFlowFold, TokenFlowHandoff } from "./TokenFlow";
import { TranscriptGrowth, useTranscriptFold } from "./TranscriptGrowth";
import { MarkdownBody } from "./MarkdownBody";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { FormDialog } from "./FormDialog";
import { ToolReportDialog } from "./ToolReportDialog";
import { usePromptCacheLossDialog } from "./PromptCacheLossDialog";
import { AnsiText } from "./AnsiText";
import { OmpWordmark } from "./OmpWordmark";
import { useI18n } from "@/hooks/useI18n";
import { phaseLabel } from "@/lib/chat-phase-label";
import { useAgentSession, type AgentEndInfo, type NewSessionChoices, type NoticeItem } from "@/hooks/useAgentSession";
import { useSyncedDisplaySettings } from "@/hooks/useDisplaySettings";
import { ChatAnimationsContext, useEffectiveChatAnimationDuration } from "@/hooks/useChatAnimations";
import { useProviderUsage } from "@/hooks/useProviderUsage";
import { useShowCostWithUsage } from "@/hooks/useShowCostWithUsage";
import { useTokenDisplay, type TokenDisplayMode } from "@/hooks/useTokenDisplay";
import { useTokenFlowConnections } from "@/hooks/useTokenFlowConnections";
import type { ProviderUsageSummary } from "@/lib/provider-usage-types";
import { formatTokenCount } from "@/lib/format-tokens";
import { selectHasStreamingContent, selectIsStreaming, useStreamingSelector } from "@/hooks/useStreamingSelector";
import { useSequencedReply } from "@/hooks/useSequencedReply";
import type { StreamingStore } from "@/lib/streaming-message";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import type { GoalStatusInfo, SessionStatsInfo } from "@/lib/omp-types";
import type { AppUpdateResponse } from "@/lib/api-types";
import type { ToolEntry } from "@/lib/tool-presets";
import type { OmpSettingsShortcut } from "@/lib/settings-navigation";
import { getTranscriptNotices, summarizeCacheMisses, type CacheMissSummary } from "@/lib/transcript-notices";
import { cacheMissSummaryText, TRANSCRIPT_NOTICE_WARNING_COLOR, TranscriptNoticeLines } from "@/components/TranscriptNotices";
import { findChatScrollAnchor, type ChatScrollPosition } from "@/lib/chat-scroll-position";
import {
  CHAT_SCROLL_TAIL_TOLERANCE,
  captureScrollDistance,
  getNextVisibleCount,
  getNextWindowCount,
  getPromptAnchorSpacerHeight,
  getVisibleRenderWindow,
  isScrollAtTail,
  LOAD_OLDER_PAGE_TAIL,
  RESTORE_ENTRY_BUDGET,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";

interface Props {
  session: SessionInfo | null;
  searchTarget?: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled?: (target: { sessionId: string; entryId: string }) => void;
  initialScrollPosition?: ChatScrollPosition | null;
  onScrollPositionChange?: (sessionId: string, position: ChatScrollPosition) => void;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  /** Shown above the composer while a fresh composer is still empty: where its session starts. */
  newSessionContextBar?: ReactNode;
  /** A fresh composer's model and reasoning picks, carried from the composer it replaces. */
  initialNewSessionChoices?: NewSessionChoices | null;
  onNewSessionChoicesChange?: (choices: NewSessionChoices) => void;
  onAgentEnd?: (end: AgentEndInfo) => void;
  onToolEnd?: (toolName: string) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string, runtimeId?: string | null) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked: boolean) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** Opens a section of the omp config browser from a composer shortcut. */
  onOpenSettings?: (section: OmpSettingsShortcut) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  /** Subscription usage of the account behind the current model; null hides it and keeps cost visible. */
  onProviderUsageChange?: (usage: ProviderUsageSummary | null) => void;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Files dropped onto the chat were written into the working directory. */
  onFilesUploaded?: () => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  onAskInNewChat?: (prompt: string, sourceSessionId: string, sourceEntryId: string) => Promise<void>;
  quoteSelectionEnabled?: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
  onSubagentsChange?: (subagents: SubagentSnapshot[]) => void;
  onBackgroundJobsChange?: (jobs: BackgroundJob[]) => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
  /** Keeps the completion sound's audio running until the returned release is called. */
  holdAudio?: () => () => void;
}
const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;

// One update check per page. Every fresh composer mounts the header again
// (each move of the new-session bar does), and a link that turned up late
// each time would lengthen the versions line under the reader's eyes; from
// the second header on it is there in the first paint.
let appUpdateCheck: Promise<AppUpdateResponse | null> | null = null;
let appUpdateFound: AppUpdateResponse | null = null;

function checkAppUpdate(): Promise<AppUpdateResponse | null> {
  appUpdateCheck ??= fetch("/api/app-update")
    .then(async (response) => {
      if (!response.ok) return null;
      const result = await response.json() as AppUpdateResponse;
      return result.updateAvailable && result.latestVersion && result.releaseUrl ? result : null;
    })
    .then((result) => {
      appUpdateFound = result;
      return result;
    })
    .catch(() => {
      // Update checks are best-effort and must not interrupt a new session;
      // a later header asks again.
      appUpdateCheck = null;
      return null;
    });
  return appUpdateCheck;
}

function NewSessionUpdateLink({
  label,
}: {
  label: (version: string) => string;
}) {
  const [update, setUpdate] = useState<AppUpdateResponse | null>(() => appUpdateFound);

  useEffect(() => {
    if (appUpdateFound) return;
    let cancelled = false;
    void checkAppUpdate().then((result) => {
      if (!cancelled && result) setUpdate(result);
    });
    return () => { cancelled = true; };
  }, []);

  if (!update) return null;
  const accessibleLabel = label(update.latestVersion);

  // In the versions line, after the version in use: "→ v<latest> ↗".
  return (
    <>
      <span className="new-session-meta-arrow" aria-hidden="true">→</span>
      <a
        className="new-session-update"
        href={update.releaseUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={accessibleLabel}
        aria-label={accessibleLabel}
      >
        v{update.latestVersion}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 17 17 7" />
          <path d="M7 7h10v10" />
        </svg>
      </a>
    </>
  );
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function ProcessDetailsGroup({ messageCount, requestCount = 0, toolCallCount, failureCount, compaction = false, status, durationMs, cacheMisses, tokenDisplay = "text", usage, missingUsage = false, models = [], defaultExpanded = false, reveal = false, renderDetails, t }: {
  messageCount: number;
  requestCount?: number;
  toolCallCount: number;
  failureCount: number;
  compaction?: boolean;
  status?: string;
  durationMs?: number;
  cacheMisses?: CacheMissSummary;
  tokenDisplay?: TokenDisplayMode;
  usage?: Pick<AgentUsage, "input" | "output" | "cacheRead" | "cacheWrite">;
  missingUsage?: boolean;
  defaultExpanded?: boolean;
  models?: { provider: string; model: string }[];
  reveal?: boolean;
  renderDetails: () => ReactNode;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const preference = useExpansionPreference("process");
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? (preference === "automatic" ? defaultExpanded : preference === "expanded");
  useLayoutEffect(() => {
    if (reveal) setManualExpanded(true);
  }, [reveal]);
  const collapsed = !expanded && !reveal;
  const { detailsRef, showDetails, bracketRef, bracketsMoving, measureBrackets } = useTranscriptFold(collapsed, reveal, tokenDisplay === "flow");
  const details = showDetails ? (
    <div ref={detailsRef} data-fold-details="" inert={collapsed} style={tokenDisplay === "flow" ? undefined : { marginTop: 8 }}>
      <div className="flow-root">{renderDetails()}</div>
    </div>
  ) : null;
  const sizeParts: string[] = [];
  if (messageCount > 0) sizeParts.push(`${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`);
  if (requestCount > 0) sizeParts.push(`${requestCount} ${t(requestCount === 1 ? "chat.modelRequest" : "chat.modelRequests")}`);
  const toolParts: string[] = [];
  if (toolCallCount > 0) toolParts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);
  const otherParts: string[] = [];
  if (compaction) otherParts.push(t("i18n.conversationCompacted"));
  if (status && collapsed) otherParts.push(status);
  if (durationMs !== undefined) otherParts.push(t("chat.turnDuration", { time: formatTurnDuration(durationMs) }));
  const parts = [...sizeParts, ...toolParts, ...otherParts];
  // Folded, the cache misses inside are added up here; open, each shows under its step.
  const cacheMissText = cacheMisses && !(expanded || reveal) ? cacheMissSummaryText(t, cacheMisses) : undefined;
  const failureText = failureCount > 0 && !(expanded || reveal) ? t("chat.processFailures", { count: failureCount }) : undefined;

  const expandedNow = expanded || reveal;
  const toggleIcon = (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 6h7" />
      {!expandedNow && <path d="M6 2.5v7" />}
    </svg>
  );
  const summary = (
    <>
      {parts.join(" · ")}
      {failureText && <span style={{ color: TRANSCRIPT_NOTICE_WARNING_COLOR }}>{` · ${failureText}`}</span>}
      {cacheMissText && ` · ${cacheMissText}`}
    </>
  );
  const foldSummaryId = useId();
  const toggleProps = {
    type: "button" as const,
    "aria-expanded": !collapsed,
    onClick: () => setManualExpanded(collapsed),
    title: collapsed ? t("chat.expandProcess") : t("chat.collapseProcess"),
  };
  const toggle = (
    <button
      {...toggleProps}
      className="transcript-fold-toggle"
      aria-label={t("chat.processDetails")}
      aria-describedby={foldSummaryId}
    >
      <span style={{ flexShrink: 0, display: "inline-flex" }} aria-hidden="true">{toggleIcon}</span>
      <span className="transcript-fold-label" id={foldSummaryId} dir="auto">
        <span>{summary}</span>
        {collapsed && tokenDisplay === "text" && requestCount > 0 && <FoldTokenTotals usage={usage} missing={missingUsage} />}
      </span>
    </button>
  );
  // In flow mode a run of requests is drawn on the wire: collapsed as a bracketed turn marker whose rows hold the
  // fold's stats, open as a handoff row. Either way the toggle is an icon button on the wire.
  let body: ReactNode;
  if (tokenDisplay === "flow") {
    const summaryLabel = [t("chat.processDetails"), ...parts, failureText, cacheMissText].filter(Boolean).join(" · ");
    const iconToggle = (
      <button {...toggleProps} className="token-flow-handoff-icon token-flow-fold-toggle" aria-label={summaryLabel}>{toggleIcon}</button>
    );
    const foldProps = {
      usage, missing: missingUsage, models, hasRequests: requestCount > 0,
      outputRows: [...sizeParts, ...otherParts],
      inputRows: [...toolParts, failureText && <span style={{ color: TRANSCRIPT_NOTICE_WARNING_COLOR }}>{failureText}</span>, cacheMissText].filter(Boolean),
    };
    body = (
      <div className="transcript-process transcript-flow-fold-group" data-fold-moving={bracketsMoving ? "" : undefined}>
        <div ref={bracketRef} className="transcript-fold-brackets" aria-hidden="true" />
        {showDetails ? (
          <>
            {measureBrackets && <div className="transcript-fold-measure" aria-hidden="true"><TokenFlowFold {...foldProps} measure /></div>}
            <TokenFlowHandoff kind="process" label={summaryLabel} time={null}>{iconToggle}</TokenFlowHandoff>
            {details}
            <TokenFlowHandoff kind="process-end" label={summaryLabel} time={null}>{iconToggle}</TokenFlowHandoff>
          </>
        ) : <TokenFlowFold {...foldProps} bottomToggle={iconToggle}>{iconToggle}</TokenFlowFold>}
      </div>
    );
  } else {
    body = (
      <div className="transcript-process">
        {toggle}
        {details}
        {showDetails && <button {...toggleProps} className="transcript-fold-toggle" aria-label={toggleProps.title}>{toggleIcon}</button>}
      </div>
    );
  }
  return body;
}

export function ChatWindow({ session, searchTarget, onSearchTargetHandled, initialScrollPosition, onScrollPositionChange, sessionRunning, newSessionCwd, newSessionDraftKey, newSessionContextBar, initialNewSessionChoices, onNewSessionChoicesChange, onAgentEnd, onToolEnd, onAttentionNeeded, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, onOpenSettings, onContextUsageChange, onProviderUsageChange, onOpenFile, onFilesUploaded, onOpenSubagent, onAskInNewChat, quoteSelectionEnabled = false, initialPrompt, onInitialPromptConsumed, onSubagentsChange, onBackgroundJobsChange, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio, holdAudio }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const animationDuration = useEffectiveChatAnimationDuration();
  const chatAnimations = animationDuration > 0;
  const completionNotificationsEnabled = session?.relation?.kind !== "subagent";

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const extensionDialogShownRef = useRef(false);
  const [composerHandoff, setComposerHandoff] = useState(0);
  useEffect(() => {
    if (!chatAnimations) setComposerHandoff(0);
  }, [chatAnimations]);
  const wrappedOnAgentEnd = useCallback((end: AgentEndInfo) => {
    // A run someone stopped did not finish anything.
    if (chatAnimations && !end.aborted) setComposerHandoff((turn) => turn + 1);
    if (completionNotificationsEnabled && soundEnabledRef.current && !end.aborted) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.(end);
  }, [chatAnimations, completionNotificationsEnabled, onAgentEnd]);

  const initialScrollPositionRef = useRef(searchTarget ? null : initialScrollPosition ?? null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<Extract<ChatScrollPosition, { atBottom: false }> | null>(() => {
    const position = initialScrollPositionRef.current;
    return position && !position.atBottom ? position : null;
  });
  const [restoreAnchorReady, setRestoreAnchorReady] = useState(false);
  const [toolsReport, setToolsReport] = useState<string | null>(null);
  const cacheLoss = usePromptCacheLossDialog();

  const {
    loading, error, messages, activeToolResults, entryIds, messageKeys, historyCursor, hasEarlierMessages, earlierTurnCount, streamingStore,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, modelRoles, thinkingLevel,
    effectiveThinkingLevel,
    composerStatus,
    sessionAccent,
    retryInfo, contextUsage, promptCache, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, subagents,
    backgroundJobs,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput, setNoticePaused, addNotice,
    isAutoModelSelection,
    isAutoThinkingSelection,
    defaultModel,
    savedDefaultThinkingLevel,
    agentPhase,
    isNew,
    editEntryId,
    showScrollToBottom,
    goalStatus,
    sessionIdRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive,
    handleSend, handleAbort, handleFork, handleEditContent, cancelEdit, handleModelChange, handleRoleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    dismissCompactError,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, handleSetDefaultModel, handleSetDefaultThinkingLevel, loadSlashCommands, scrollUserMsgToTop,
    loadContext, activeLeafId, scrollToBottom, scrollToMessage, resumeAutoFollow, autoFollowPaused,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, newSessionDraftKey, initialNewSessionChoices, onNewSessionChoicesChange, onAgentEnd: wrappedOnAgentEnd, onToolEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
    onOpenSettings, onToolsReport: setToolsReport,
    deferInitialScroll: Boolean(pendingScrollRestore),
    confirmPromptCacheLoss: cacheLoss.confirm,
  });
  // Only whether a reply is streaming and has content yet: the chunks themselves
  // re-render StreamingReply alone.
  const isStreaming = useStreamingSelector(streamingStore, selectIsStreaming);
  const hasStreamingContent = useStreamingSelector(streamingStore, selectHasStreamingContent);
  const visibleReplyStartsRef = useRef(new Set<number>());
  const [presentingReply, setPresentingReply] = useState<number | undefined>();
  const getStreamingMessage = useCallback(() => streamingStore.getState().streamingMessage, [streamingStore]);
  const sessionBusy = agentRunning || bashRunning;
  // omp's render-affecting settings (hideThinkingBlock, display.cacheMissMarker).
  // Synced here once for the whole transcript; MessageView reads the shared store directly.
  const { hideThinkingBlock, cacheMissMarker } = useSyncedDisplaySettings(newSessionCwd ?? session?.cwd ?? null);
  const displayOptions = useMemo<DisplayOptions>(() => ({ hideThinking: hideThinkingBlock }), [hideThinkingBlock]);
  const transcript = useMemo(() => {
    const retainedIndex = presentingReply === undefined ? -1 : messages.findLastIndex(
      (message) => message.role === "assistant" && message.timestamp === presentingReply,
    );
    return buildChatTranscript(retainedIndex < 0 ? messages : messages.slice(0, retainedIndex), displayOptions, cacheMissMarker);
  }, [messages, displayOptions, cacheMissMarker, presentingReply]);
  // While this session's run is under way its chime may come with the phone
  // locked, where a suspended context cannot start again (#1157).
  useEffect(() => {
    if (!agentRunning || !holdAudio) return;
    return holdAudio();
  }, [agentRunning, holdAudio]);
  const [quotedSelection, setQuotedSelection] = useState<{
    text: string;
    top: number;
    left: number;
    sourceEntryId?: string;
  } | null>(null);
  const [quoteInputOpen, setQuoteInputOpen] = useState(false);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quotePopoverRef = useRef<HTMLDivElement | null>(null);
  const quoteChatInputRef = useRef<ChatInputHandle | null>(null);
  const closeQuotedSelection = useCallback(() => {
    setQuotedSelection(null);
    setQuoteInputOpen(false);
    setQuoteError(null);
  }, []);

  useEffect(() => {
    if (!quoteSelectionEnabled) closeQuotedSelection();
  }, [quoteSelectionEnabled, closeQuotedSelection]);

  const captureQuotedSelection = useCallback(() => {
    if (!quoteSelectionEnabled || quoteInputOpen) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const root = messageContentRef.current;
    if (!selection || selection.isCollapsed || !range || !root || !root.contains(range.commonAncestorContainer)) {
      setQuotedSelection(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setQuotedSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer as Element
      : range.endContainer.parentElement;
    const sourceEntryId = [ancestor, start, end]
      .map((element) => element?.closest<HTMLElement>("[data-message-role=\"assistant\"]")?.dataset.entryId)
      .find((entryId): entryId is string => Boolean(entryId));
    setQuotedSelection({
      text,
      top: Math.min(window.innerHeight - 44, rect.bottom + 8),
      left: Math.max(64, Math.min(window.innerWidth - 64, rect.left + rect.width / 2)),
      sourceEntryId,
    });
  }, [quoteSelectionEnabled, quoteInputOpen]);

  useEffect(() => {
    if (!quoteInputOpen || !quotedSelection) return;
    quoteChatInputRef.current?.insertIfEmpty(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
  }, [quoteInputOpen, quotedSelection, t]);

  useLayoutEffect(() => {
    const popover = quotePopoverRef.current;
    if (!popover || !quotedSelection) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = popover.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      popover.style.top = `${Math.max(top + 8, Math.min(quotedSelection.top, top + (viewport?.height ?? window.innerHeight) - rect.height - 8))}px`;
      popover.style.left = `${Math.max(left + 8, Math.min(quotedSelection.left - rect.width / 2, left + (viewport?.width ?? window.innerWidth) - rect.width - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [quotedSelection, quoteInputOpen, quoteError]);

  useEffect(() => {
    if (!quotedSelection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!quoteInputOpen && !quotePopoverRef.current?.contains(event.target as Node)) closeQuotedSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!quoteSubmitting) closeQuotedSelection();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [quotedSelection, quoteInputOpen, quoteSubmitting, closeQuotedSelection]);

  const askSelectionHere = useCallback(() => {
    if (!quotedSelection) return;
    chatInputRef?.current?.insertText(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
    // No `removeAllRanges()` here: inserting focuses the composer, and that
    // focus already collapses the page's selection. Calling it afterwards also
    // clears the composer's own selection and drops its caret to offset 0
    // (#1319), so the quote would be typed in front of instead of after.
    closeQuotedSelection();
  }, [chatInputRef, quotedSelection, closeQuotedSelection, t]);

  const askSelectionInNewChat = useCallback(async (prompt: string) => {
    const sourceSessionId = sessionIdRef.current ?? session?.id;
    if (quoteSubmitting || !prompt.trim() || !quotedSelection?.sourceEntryId || !sourceSessionId || !onAskInNewChat) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    unlockAudio?.();
    try {
      await onAskInNewChat(
        prompt,
        sourceSessionId,
        quotedSelection.sourceEntryId,
      );
      closeQuotedSelection();
    } catch (error) {
      quoteChatInputRef.current?.restoreSubmission(prompt);
      setQuoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuoteSubmitting(false);
    }
  }, [onAskInNewChat, quotedSelection, quoteSubmitting, session?.id, sessionIdRef, closeQuotedSelection, unlockAudio]);

  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (loading || error || !initialPrompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.();
    void handleSend(initialPrompt);
  }, [initialPrompt, loading, error, handleSend, onInitialPromptConsumed]);

  // One sound when a dialog appears with none on screen. A dialog queued behind
  // another one surfaces the moment the user answers that one, so it stays quiet.
  useEffect(() => {
    const surfaced = Boolean(extensionDialog) && !extensionDialogShownRef.current;
    extensionDialogShownRef.current = Boolean(extensionDialog);
    if (!completionNotificationsEnabled || !surfaced) return;
    playDoneSoundRef.current();
  }, [completionNotificationsEnabled, extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  // State, not a ref: the sentinel can appear with nothing else changing (a
  // finished turn regrouped into more rows), and must get an observer then.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const composerWireRef = useRef<SVGSVGElement | null>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  const prevVisibleCountRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  const restoreStartedRef = useRef(false);
  const pendingScrollRestoreRef = useRef(pendingScrollRestore);
  pendingScrollRestoreRef.current = pendingScrollRestore;
  const [pendingSearchScroll, setPendingSearchScroll] = useState<Props["searchTarget"]>(null);
  const searchMessage = messages[entryIds.indexOf(pendingSearchScroll?.entryId ?? "")];
  const searchBlock = searchMessage?.role === "assistant"
    ? (pendingSearchScroll?.blockIndex === undefined
      ? searchMessage.content.find((block) => block.type === "text")
      : searchMessage.content[pendingSearchScroll.blockIndex])
    : undefined;
  const searchHistoryRef = useRef({ entryIds, historyCursor, hasEarlierMessages });
  searchHistoryRef.current = { entryIds, historyCursor, hasEarlierMessages };
  // The cursor of the older page asked for last, kept until the next cursor
  // renders: the page lands, and loadingOlderRef clears, a moment before that
  // render, and an observer report in between still holds this cursor.
  const requestedCursorRef = useRef<string | null>(null);
  const loadOlderPage = useCallback(async (sid: string, before: string, options?: { tail?: number; signal?: AbortSignal }) => {
    requestedCursorRef.current = before;
    const page = await loadContext(sid, activeLeafId, before, options);
    // Only a landed page is an object; a superseded or failed request answers
    // false, and then the same page may be asked for again.
    const context = typeof page === "object" ? page : null;
    if (!context && requestedCursorRef.current === before) requestedCursorRef.current = null;
    return context;
  }, [activeLeafId, loadContext]);
  useEffect(() => {
    // A reloaded history can come back to a cursor asked for before.
    if (historyCursor !== requestedCursorRef.current) requestedCursorRef.current = null;
  }, [historyCursor]);

  useLayoutEffect(() => {
    const sessionId = session?.id;
    const container = scrollContainerRef.current;
    const content = messageContentRef.current;
    if (!sessionId || !onScrollPositionChange || !container || !content) return;
    return () => {
      if (pendingScrollRestoreRef.current) return;
      if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        onScrollPositionChange(sessionId, { atBottom: true });
        return;
      }
      const viewportTop = container.getBoundingClientRect().top;
      const candidates = Array.from(content.querySelectorAll<HTMLElement>("[data-chat-scroll-anchor]"), (element) => {
        const rect = element.getBoundingClientRect();
        return { entryId: element.dataset.entryId!, top: rect.top, bottom: rect.bottom };
      });
      const anchor = findChatScrollAnchor(candidates, viewportTop);
      if (!anchor) return;
      onScrollPositionChange(sessionId, {
        atBottom: false,
        ...anchor,
        oldestEntryId: searchHistoryRef.current.historyCursor,
      });
    };
  }, [loading, onScrollPositionChange, scrollContainerRef, session?.id]);

  useEffect(() => {
    if (searchTarget) setPendingScrollRestore(null);
  }, [searchTarget]);

  useEffect(() => {
    const position = pendingScrollRestore;
    const sessionId = session?.id;
    if (!position || !sessionId || loading || searchTarget || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    const controller = new AbortController();

    const locate = async () => {
      const initialHistory = searchHistoryRef.current;
      if (initialHistory.entryIds.includes(position.anchorEntryId)) {
        setVisibleCount((current) => Math.max(current, initialHistory.entryIds.length * 2));
        setRestoreAnchorReady(true);
        return;
      }

      loadingOlderRef.current = true;
      let before = initialHistory.historyCursor;
      let hasMore = initialHistory.hasEarlierMessages;
      // Bound automatic restore's network work. Deeper history is still
      // reachable by scrolling and paging it in on demand.
      let scannedEntries = initialHistory.entryIds.length;
      try {
        while (hasMore && before && !controller.signal.aborted && scannedEntries < RESTORE_ENTRY_BUDGET) {
          const context = await loadOlderPage(sessionId, before, { signal: controller.signal, tail: LOAD_OLDER_PAGE_TAIL });
          if (controller.signal.aborted) return;
          if (!context) {
            scrollToBottom("instant");
            setPendingScrollRestore(null);
            return;
          }
          scannedEntries += context.entryIds?.length ?? context.messages.length;
          setVisibleCount((current) => current + Math.max(VISIBLE_PAGE_SIZE, context.messages.length + VISIBLE_PAGE_SIZE));
          if (context.entryIds.includes(position.anchorEntryId)) {
            setRestoreAnchorReady(true);
            return;
          }
          if (context.oldestEntryId === position.oldestEntryId) break;
          before = context.oldestEntryId ?? null;
          hasMore = context.hasMore === true;
        }
        if (!controller.signal.aborted) {
          scrollToBottom("instant");
          setPendingScrollRestore(null);
        }
      } finally {
        loadingOlderRef.current = false;
      }
    };

    void locate();
    return () => {
      controller.abort();
      // A branch change cancels restoration and must reveal the new context.
      setPendingScrollRestore(null);
    };
  }, [activeLeafId, loadOlderPage, loading, pendingScrollRestore, scrollToBottom, searchTarget, session?.id]);

  useLayoutEffect(() => {
    const position = pendingScrollRestore;
    const content = messageContentRef.current;
    if (!position || !content || searchTarget) return;
    const element = content.querySelector<HTMLElement>(`[data-chat-scroll-anchor][data-entry-id="${CSS.escape(position.anchorEntryId)}"]`);
    if (element instanceof HTMLElement) {
      scrollToMessage(element, position.anchorOffset);
      setPendingScrollRestore(null);
      return;
    }
    if (restoreAnchorReady) {
      scrollToBottom("instant");
      setPendingScrollRestore(null);
    }
  }, [entryIds, pendingScrollRestore, restoreAnchorReady, scrollToBottom, scrollToMessage, searchTarget, visibleCount]);

  useEffect(() => {
    if (!searchTarget || loading) return;
    const controller = new AbortController();
    const locate = async () => {
      const history = searchHistoryRef.current;
      let found = history.entryIds.includes(searchTarget.entryId);
      if (!found && !sessionBusy && history.hasEarlierMessages && history.historyCursor && !loadingOlderRef.current) {
        loadingOlderRef.current = true;
        const container = scrollContainerRef.current;
        if (container) prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        // ponytail: one extra page of 200 entries; deeper or other-branch hits just open the session.
        const context = await loadOlderPage(searchTarget.sessionId, history.historyCursor, { tail: 200, signal: controller.signal });
        loadingOlderRef.current = false;
        found = Boolean(context?.entryIds.includes(searchTarget.entryId));
      }
      if (controller.signal.aborted) return;
      if (found) {
        prevScrollDistanceRef.current = null;
        setVisibleCount((current) => Math.max(current, (searchHistoryRef.current.entryIds.length + 200) * 2));
        setPendingSearchScroll(searchTarget);
      } else {
        onSearchTargetHandled?.(searchTarget);
      }
    };
    void locate();
    return () => controller.abort();
  }, [searchTarget, loading, sessionBusy, loadOlderPage, onSearchTargetHandled, scrollContainerRef]);

  useLayoutEffect(() => {
    if (!pendingSearchScroll || pendingSearchScroll !== searchTarget) return;
    const selector = `[data-entry-id="${CSS.escape(pendingSearchScroll.entryId)}"]`;
    const element = scrollContainerRef.current?.querySelector<HTMLElement>(searchMessage?.role === "user" ? selector : `${selector} [data-search-target]`);
    if (element) {
      scrollToMessage(element);
      element.animate([
        { backgroundColor: "var(--bg-selected)" },
        { backgroundColor: "transparent" },
      ], { duration: 2500 });
    }
    setPendingSearchScroll(null);
    onSearchTargetHandled?.(pendingSearchScroll);
  }, [pendingSearchScroll, searchTarget, searchMessage, scrollContainerRef, scrollToMessage, onSearchTargetHandled]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (loadingOlderRef.current) return;
        // Only a view riding the tail may ignore the sentinel: it wants no
        // older turns, and paging here would store a bottom-distance
        // measured on un-expanded content (a mount-time artifact that a
        // later restore would misapply toward the window's top). Position,
        // not the follow flag, is the honest signal — a restored session
        // can be "attached" by flag yet sitting at the top of its window,
        // where the reader absolutely does want the older page.
        if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) return;
        if (!hasEarlierMessages) {
          // Everything is loaded, yet the sentinel shows: the messages render as
          // more rows than the window holds (an answer and its thinking are
          // two), so widen the window. The observer is renewed with it, in case
          // the sentinel stays in view.
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          setVisibleCount((current) => getNextVisibleCount(current));
          return;
        }
        // Fetch the previous page from the server and prepend it (loadContext
        // handles prepend + scroll anchoring).
        const oldestId = historyCursor;
        // Its page already landed; the next cursor has not rendered yet.
        if (!oldestId || oldestId === requestedCursorRef.current) return;
        const sid = session?.id ?? sessionIdRef.current;
        if (!sid) return;
        loadingOlderRef.current = true;
        prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        void loadOlderPage(sid, oldestId, { tail: LOAD_OLDER_PAGE_TAIL }).finally(() => {
          loadingOlderRef.current = false;
        });
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, visibleCount, historyCursor, hasEarlierMessages, session, loadOlderPage, sessionIdRef, scrollContainerRef]);

  // Sliding tail window: while the view rides the newest turn, new commits
  // slide in at the bottom and the oldest rendered rows drop off the top
  // (they stay on the server; the sentinel re-pages them). While detached —
  // reading older content — the window keeps growing to cover every loaded
  // row so prepended pages are never sliced away mid-read.
  useEffect(() => {
    // Read the follow flag the streaming/scroll effects own, not a one-tick
    // scroll sample: a fresh commit grows the content before auto-scroll
    // catches up, so an instantaneous position probe misreads "attached".
    setVisibleCount((current) => getNextWindowCount(current, transcript.rows.length, !autoFollowPaused));
  }, [transcript.rows.length, autoFollowPaused]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    const previous = prevVisibleCountRef.current;
    prevVisibleCountRef.current = visibleCount;
    if (prevScrollDistanceRef.current == null) return;
    // Only growth is a prepend. A slide (the window trimming rows off the
    // top) has nothing to restore, and consuming the saved distance there
    // would misplace the view by the trimmed height.
    if (previous !== null && visibleCount <= previous) {
      prevScrollDistanceRef.current = null;
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) return;
    // A view that has come to rest on the tail stays there: prepending
    // above the tail does not change what the tail shows, so the only
    // thing a large pending distance could do now is yank the reader off
    // the newest turn toward the window's top. A distance captured while
    // already riding the tail (≤ tolerance) simply re-pins the bottom.
    if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)
        && prevScrollDistanceRef.current > CHAT_SCROLL_TAIL_TOLERANCE) {
      prevScrollDistanceRef.current = null;
      return;
    }
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
      sessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  // Subscription usage replaces cost in the top bar and the per-request lines, unless the user keeps cost.
  const providerUsage = useProviderUsage(displayModelValue, session?.id);
  const showCostWithUsage = useShowCostWithUsage();
  const hideCost = providerUsage !== null && !showCostWithUsage;
  useEffect(() => {
    onProviderUsageChange?.(providerUsage);
  }, [providerUsage, onProviderUsageChange]);
  useEffect(() => () => { onProviderUsageChange?.(null); }, [onProviderUsageChange]);
  useEffect(() => {
    onSubagentsChange?.(subagents);
  }, [onSubagentsChange, subagents]);
  useEffect(() => () => { onSubagentsChange?.([]); }, [onSubagentsChange]);
  useEffect(() => {
    onBackgroundJobsChange?.(backgroundJobs);
  }, [backgroundJobs, onBackgroundJobsChange]);
  useEffect(() => () => { onBackgroundJobsChange?.([]); }, [onBackgroundJobsChange]);


  // Images attach to the prompt. Other files go through the file explorer's
  // upload into the working directory, never replacing a file already there,
  // and come back as @mentions. The composer's attach button takes the same
  // path, for phones that cannot drop files.
  const uploadDroppedFiles = useCallback(async (files: File[]) => {
    const cwd = session?.cwd ?? newSessionCwd;
    if (!cwd) {
      addNotice({ type: "warning", message: t("chat.dropNeedsCwd") });
      return;
    }
    try {
      const { status, data } = await uploadFiles(cwd, files, "skip");
      if (status !== 200 && status !== 207) throw new Error(data.error ?? `HTTP ${status}`);
      const uploaded = data.uploaded ?? [];
      const skipped = data.skipped ?? [];
      const mentions = dropMentionText(files, [...uploaded, ...skipped]);
      if (mentions) chatInputRef?.current?.insertText(mentions);
      if (uploaded.length > 0) {
        addNotice({ type: "success", message: t("chat.dropUploaded", { count: uploaded.length }) });
        onFilesUploaded?.();
      }
      if (skipped.length > 0) {
        addNotice({ type: "warning", message: t("chat.dropAlreadyExists", { names: skipped.join(", ") }) });
      }
      for (const failure of data.errors ?? []) {
        addNotice({ type: "error", message: t("chat.dropFailed", { message: `${failure.name}: ${failure.error}` }) });
      }
    } catch (uploadError) {
      addNotice({ type: "error", message: t("chat.dropFailed", { message: uploadError instanceof Error ? uploadError.message : String(uploadError) }) });
    }
  }, [addNotice, chatInputRef, newSessionCwd, onFilesUploaded, session?.cwd, t]);

  const onDrop = useCallback((items: DroppedItem[]) => {
    const { images, files, folders } = splitDroppedItems(items);
    if (images.length > 0) chatInputRef?.current?.addImages(images);
    if (folders.length > 0) {
      addNotice({ type: "warning", message: t("chat.dropFoldersUnsupported", { names: folders.join(", ") }) });
    }
    if (files.length > 0) void uploadDroppedFiles(files);
  }, [addNotice, chatInputRef, t, uploadDroppedFiles]);

  const onAttachFiles = useCallback((files: File[]) => {
    onDrop(files.map((file) => ({ kind: "file", file })));
  }, [onDrop]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamingStore), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    const map = new Map(activeToolResults);
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    attachDeferredTaskResults(map, messages);
    return map;
  }, [activeToolResults, messages]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);

  const isEmptyNew = isNew && messages.length === 0 && !isStreaming && !sessionBusy;
  const tokenDisplay = useTokenDisplay();
  const showTokenFlow = tokenDisplay === "flow" && !loading && !error && !isEmptyNew;
  const waitingForModel = showTokenFlow && agentRunning && agentPhase?.kind === "waiting_model"
    && !isCompacting && !retryInfo && !extensionDialog;
  useTokenFlowConnections(showTokenFlow, messageContentRef, composerWireRef, true);
  useScrollbarVisibility(scrollContainerRef, Boolean(session?.id) || !isEmptyNew);
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const promptAnchorSpacerRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerHeightRef = useRef(0);
  const promptAnchorMeasureFrameRef = useRef<number | null>(null);
  const promptAnchorAdjustmentDoneRef = useRef(false);
  const promptAnchorUpdateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const spacer = promptAnchorSpacerRef.current;
    if (!promptAnchorActive) {
      promptAnchorUpdateRef.current = null;
      promptAnchorSpacerHeightRef.current = 0;
      promptAnchorAdjustmentDoneRef.current = false;
      if (spacer) spacer.style.height = "";
      return;
    }

    const container = scrollContainerRef.current;
    const messageContent = messageContentRef.current;
    const userMessage = lastUserMsgRef.current;
    if (!container || !messageContent || !userMessage || !spacer) return;

    let disposed = false;
    const updatePromptAnchorSpacer = () => {
      if (
        disposed
        || scrollContainerRef.current !== container
        || messageContentRef.current !== messageContent
        || lastUserMsgRef.current !== userMessage
        || promptAnchorSpacerRef.current !== spacer
      ) return;

      const containerTop = container.getBoundingClientRect().top;
      const userMessageTop = userMessage.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const targetTop = Math.max(0, userMessageTop - 16);
      const contentEnd = spacer.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const nextPromptAnchorSpacerHeight = getPromptAnchorSpacerHeight(
        targetTop,
        contentEnd,
        container.clientHeight,
      );

      const isInitialMeasurement = !promptAnchorAdjustmentDoneRef.current;
      const needsInitialAdjustment = isInitialMeasurement
        && nextPromptAnchorSpacerHeight > 0;
      if (isInitialMeasurement) promptAnchorAdjustmentDoneRef.current = true;
      if (nextPromptAnchorSpacerHeight !== promptAnchorSpacerHeightRef.current) {
        promptAnchorSpacerHeightRef.current = nextPromptAnchorSpacerHeight;
        spacer.style.height = nextPromptAnchorSpacerHeight > 0
          ? `${nextPromptAnchorSpacerHeight}px`
          : "";
      }
      if (needsInitialAdjustment && !autoFollowPaused) scrollUserMsgToTop();
      if (agentRunning && !autoFollowPaused && !pendingScrollRestore) scrollToBottom("instant");
    };

    promptAnchorUpdateRef.current = updatePromptAnchorSpacer;
    const schedulePromptAnchorMeasure = () => {
      if (disposed || promptAnchorMeasureFrameRef.current !== null) return;
      promptAnchorMeasureFrameRef.current = requestAnimationFrame(() => {
        promptAnchorMeasureFrameRef.current = null;
        updatePromptAnchorSpacer();
      });
    };

    updatePromptAnchorSpacer();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePromptAnchorMeasure);
    observer?.observe(container);
    observer?.observe(messageContent);
    observer?.observe(userMessage);
    return () => {
      disposed = true;
      if (promptAnchorUpdateRef.current === updatePromptAnchorSpacer) {
        promptAnchorUpdateRef.current = null;
      }
      observer?.disconnect();
      if (promptAnchorMeasureFrameRef.current !== null) {
        cancelAnimationFrame(promptAnchorMeasureFrameRef.current);
        promptAnchorMeasureFrameRef.current = null;
      }
    };
  }, [
    agentRunning,
    lastUserMsgRef,
    messages.length,
    promptAnchorActive,
    scrollContainerRef,
    scrollUserMsgToTop,
    autoFollowPaused,
    pendingScrollRestore,
    scrollToBottom,
  ]);

  // Each commit of the paced reply, and the bubble coming and going.
  const updatePromptAnchor = useCallback(() => {
    promptAnchorUpdateRef.current?.();
    if (!promptAnchorActive && !autoFollowPaused && !pendingScrollRestore && (agentRunning || bashRunning)) {
      scrollToBottom("instant");
    }
  }, [promptAnchorActive, autoFollowPaused, pendingScrollRestore, agentRunning, bashRunning, scrollToBottom]);
  useLayoutEffect(updatePromptAnchor, [isStreaming, hasStreamingContent, updatePromptAnchor]);
  const onStreamingCommit = useCallback((message: AssistantMessage | null) => {
    const visible = visibleReplyStartsRef.current;
    const timestamp = message?.timestamp;
    setPresentingReply(timestamp);
    if (message && timestamp !== undefined && !visible.has(timestamp)
      && message.content.some((block) => block.type === "image" || (block.type === "text" && /\S/.test(block.text)))) {
      const oldest = visible.values().next().value;
      if (visible.size >= 64 && oldest !== undefined) visible.delete(oldest);
      visible.add(timestamp);
    }
    updatePromptAnchor();
  }, [updatePromptAnchor]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      onModelChange={handleModelChange}
      modelRoles={modelRoles}
      composerStatus={composerStatus}
      sessionAccent={sessionAccent}
      onRoleModelChange={handleRoleModelChange}
      modelSwitching={modelSwitching}
      defaultModel={defaultModel}
      onSetDefaultModel={handleSetDefaultModel}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      onDismissCompactError={dismissCompactError}
      compactResult={compactResult}
      thinkingLevel={thinkingLevel}
      effectiveThinkingLevel={effectiveThinkingLevel}
      isAutoThinkingSelection={isAutoThinkingSelection}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      savedDefaultThinkingLevel={savedDefaultThinkingLevel}
      onSetDefaultThinkingLevel={session || isNew ? handleSetDefaultThinkingLevel : undefined}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      contextUsage={contextUsage}
      promptCache={promptCache}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? newSessionDraftKey ?? undefined}
      cwd={session?.cwd ?? newSessionCwd}
      onAttachFiles={onAttachFiles}
    />
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
         {t("chat.loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <ChatAnimationsContext value={animationDuration}>
    <div
      className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
      data-chat-animations={chatAnimations ? "" : undefined}
      style={{ paddingBottom: "env(safe-area-inset-bottom)", "--chat-animation-duration": `${animationDuration}ms` } as CSSProperties}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {cacheLoss.dialog}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      <div
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
          zIndex: 40,
          display: "flex",
          // Toasts live in the top-right corner
          justifyContent: "flex-end",
          padding: `0 ${CHAT_COLUMN_PADDING}px`,
          pointerEvents: "none",
        }}
      >
        <NoticeShelf notices={notices} floating onPauseChange={setNoticePaused} />
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {toolsReport !== null && <ToolReportDialog markdown={toolsReport} onClose={() => setToolsReport(null)} />}
        {extensionDialog && (
          <ExtensionDialog key={extensionDialog.id} request={extensionDialog} onRespond={respondToExtensionUi} />
        )}
        {extensionCustomUi && (
          <ExtensionCustomPanel key={extensionCustomUi.id} request={extensionCustomUi} onInput={sendExtensionCustomInput} />
        )}
        {!isEmptyNew && <>
        <div
          ref={scrollContainerRef}
          data-chat-transcript-scroll=""
          // The message list is the one place long output has to be dragged through,
          // so it shows its scrollbar instead of hiding it behind the minimap (#788).
          // A stable gutter keeps the centred column from shifting when a short
          // session grows past one screen.
          className="scrollbar-subtle min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-gutter:stable_both-edges]"
          style={{ visibility: pendingScrollRestore ? "hidden" : undefined }}
        >
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div ref={messageContentRef} className={showTokenFlow ? "transcript-flow-layout" : undefined} onPointerUp={captureQuotedSelection} style={{ width: "100%", minWidth: 0, maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
            {(() => {
              const { rows, results, lastUserIndex: lastUserIdx, foldedRequests } = transcript;

              const pinMessage = (idx: number) => {
                const id = entryIds[idx];
                return idx === lastUserIdx || Boolean(id && (
                  id === pendingSearchScroll?.entryId || id === pendingScrollRestore?.anchorEntryId || id === editEntryId
                ));
              };
              const attachLatestPrompt = (el: HTMLDivElement | null) => { lastUserMsgRef.current = el; };

              const itemKey = (item: ChatTranscriptItem) => `${messageKeys[item.index]}-${item.kind}${item.kind === "assistant" ? `-${item.part.kind}-${item.part.start}` : ""}`;
              const matches = (item: ChatTranscriptItem, id: string | undefined, block?: AssistantContentBlock | null) => {
                if (!id || entryIds[item.index] !== id || item.kind === "model" || item.kind === "user-handoff") return false;
                if (!block || item.kind !== "assistant") return true;
                const message = messages[item.index] as AssistantMessage;
                const index = message.content.indexOf(block);
                return index >= item.part.start && index < item.part.end;
              };
              const renderItem = (item: ChatTranscriptItem, writtenFiles?: WrittenFile[], turnDurationMs?: number): ReactNode => {
                const idx = item.index;
                const msg = messages[idx];
                const key = itemKey(item);
                const part = item.kind === "assistant" ? item.part : undefined;
                const arriving = !loading && !pendingScrollRestore && idx >= lastUserIdx && !entryIds[idx];
                const wasStreamed = msg.role === "assistant" && msg.timestamp !== undefined && visibleReplyStartsRef.current.has(msg.timestamp);
                if (item.kind === "model" && msg.role === "assistant") {
                  if (!showTokenFlow) return tokenDisplay === "text" && foldedRequests.has(idx) && msg.usage
                    ? <div key={key} className="transcript-message text-xs text-text-dim">{formatUsage(msg.usage, true, true)}</div>
                    : null;
                  return <TokenFlow key={key} usage={msg.usage} provider={msg.provider} model={msg.model}
                    modelName={getModelDisplayName(msg.provider, msg.model, modelNames)} time={formatTime(msg.timestamp)} />;
                }
                if (item.kind === "user-handoff" && msg.role === "assistant") {
                  if (!showTokenFlow || ((sessionBusy || isStreaming) && idx === messages.length - 1)) return null;
                  return <TokenFlowHandoff key={key} kind="user" label={t("session.user")} time={handoffTimeOf(msg)} />;
                }
                if (item.kind === "result" && msg.role === "toolResult") {
                  const request = item.call ? messages[item.call.index] as AssistantMessage : undefined;
                  const call = item.call && request?.content[item.call.blockIndex];
                  return <TranscriptToolResult key={key} result={toolResultsMap.get(msg.toolCallId) ?? msg}
                    call={call?.type === "toolCall" ? call : undefined} requestTime={request?.timestamp} cwd={messageCwd}
                    onOpenSubagent={onOpenSubagent} live={arriving} />;
                }
                const notices = !cacheMissMarker || (part && !part.metadata) ? [] : getTranscriptNotices(msg);
                const view = (
                  <MessageView
                    key={`view-${key}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    onOpenSubagent={onOpenSubagent}
                    entryId={entryIds[idx]}
                    arrivalSpark={arriving && (msg.role === "user" || part?.kind === "chat")}
                    toolArrival={part?.kind === "call" && arriving && !wasStreamed}
                    searchBlock={entryIds[idx] === pendingSearchScroll?.entryId ? searchBlock : undefined}
                    onFork={bashRunning || isNew ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onEditContent={sessionBusy ? undefined : handleEditContent}
                    onCancelEdit={cancelEdit}
                    isEditing={editEntryId === entryIds[idx]}
                    showTimestamp={part?.metadata}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={writtenFiles}
                    turnDurationMs={turnDurationMs}
                    onCompact={part?.kind === "status" && idx === messages.length - 1 && !isStreaming ? handleCompact : undefined}
                    isCompacting={isCompacting}
                    compactError={compactError}
                    hideCost={hideCost}
                    tokenDisplay={tokenDisplay}
                    transcriptPart={part}
                    pairedToolCalls={part?.kind === "call" ? results : undefined}
                    hideTokenCounts={foldedRequests.has(idx)}
                  />
                );
                const noticeLines = notices.length > 0 ? <TranscriptNoticeLines notices={notices} /> : null;
                const port = item.kind === "input" ? "input" : undefined;
                const canReveal = item.kind === "user" || item.kind === "compaction" || item.kind === "input"
                  || part?.kind === "chat" || part?.kind === "status";
                return (
                  <div key={key} data-entry-id={entryIds[idx]}
                    data-transcript-port={port}
                    data-chat-scroll-anchor={entryIds[idx] && (isMessageGroupAnchor(msg) || part?.kind === "chat") ? "" : undefined}
                    ref={item.kind === "user" && idx === lastUserIdx ? attachLatestPrompt : undefined}>
                    {canReveal ? (
                      <TranscriptGrowth from={arriving && !wasStreamed ? 0 : undefined}
                        data-chat-arrival={arriving && !wasStreamed ? part?.kind === "status" ? "attention" : item.kind : undefined}>
                        {view}
                        {noticeLines}
                      </TranscriptGrowth>
                    ) : <>{view}{noticeLines}</>}
                  </div>
                );
              };

              const rendered: { key: string; pinned?: boolean; render: () => ReactNode }[] = [];
              let writtenStart = 0;
              let durationAnchor: number | undefined;
              let durationOnFold = false;
              for (const row of rows) {
                if (row.kind !== "fold") {
                  if (!showTokenFlow && (row.kind === "model" || row.kind === "user-handoff")) continue;
                  if (row.kind === "user") {
                    writtenStart = row.index + 1;
                    durationAnchor = entryIds[row.index] ? row.index : undefined;
                    durationOnFold = false;
                  }
                  const completed = row.kind === "assistant" && row.part.kind === "chat" && row.part.metadata
                    && (messages[row.index] as AssistantMessage).stopReason !== "toolUse";
                  const first = writtenStart;
                  const anchor = durationOnFold ? undefined : durationAnchor;
                  rendered.push({
                    key: itemKey(row),
                    pinned: pinMessage(row.index),
                    render: () => {
                      if (!completed) return renderItem(row);
                      const blocks: AssistantContentBlock[] = [];
                      for (let i = first; i <= row.index; i++) {
                        const message = messages[i];
                        if (message.role === "assistant") for (const block of message.content) {
                          if (block.type === "toolCall") blocks.push(block);
                        }
                      }
                      return renderItem(row, blocks.length ? extractTurnWrittenFiles(blocks, toolResultsMap, messageCwd) : undefined,
                        anchor === undefined ? undefined : getTurnDurationMs(messages, anchor, row.index + 1));
                    },
                  });
                  if (completed) {
                    writtenStart = row.index + 1;
                    durationAnchor = undefined;
                  }
                  continue;
                }
                const reveal = Boolean(pendingSearchScroll || pendingScrollRestore) && row.items.some((item) => matches(item, pendingSearchScroll?.entryId, searchBlock)
                  || matches(item, pendingScrollRestore?.anchorEntryId));
                const anchor = durationAnchor;
                const before = row.before;
                const finished = before?.kind === "assistant" && before.part.metadata === true
                  && (messages[before.index] as AssistantMessage).stopReason !== "toolUse";
                durationOnFold = finished;
                rendered.push({
                  key: `fold-${row.after ? itemKey(row.after) : itemKey(row.items[0])}`,
                  pinned: reveal,
                  render: () => {
                    let messageCount = 0;
                    let toolCallCount = 0;
                    let failureCount = 0;
                    let compaction = false;
                    let status: string | undefined;
                    const noticed: AgentMessage[] = [];
                    const models: { provider: string; model: string }[] = [];
                    for (const item of row.items) {
                      const message = messages[item.index];
                      if (item.kind === "model" && message.role === "assistant") models.push({ provider: message.provider, model: message.model });
                      if (item.kind === "model" || item.kind === "user-handoff") continue;
                      if (item.kind === "assistant" && item.part.kind === "status" && message.role === "assistant") {
                        if (message.stopReason === "error") status = t("chat.foldModelError");
                        if (message.stopReason === "length") status ??= t("chat.foldOutputLimit");
                      }
                      messageCount++;
                      compaction ||= item.kind === "compaction";
                      if (item.kind === "assistant" && message.role === "assistant") {
                        if (item.part.metadata) noticed.push(message);
                        for (let i = item.part.start; i < item.part.end; i++) {
                          const block = message.content[i];
                          if (block.type !== "toolCall") continue;
                          toolCallCount++;
                          if (!results.has(block.toolCallId)) failureCount += toolCallFailureCount(block, toolResultsMap.get(block.toolCallId));
                        }
                      }
                      if (item.kind === "result" && message.role === "toolResult") {
                        const call = item.call && (messages[item.call.index] as AssistantMessage).content[item.call.blockIndex];
                        const result = toolResultsMap.get(message.toolCallId) ?? message;
                        failureCount += call?.type === "toolCall" ? toolCallFailureCount(call, result) : Number(Boolean(result.isError));
                      }
                    }
                    return <ProcessDetailsGroup messageCount={messageCount} requestCount={row.requestCount} toolCallCount={toolCallCount}
                      failureCount={failureCount} compaction={compaction} status={status} tokenDisplay={tokenDisplay} usage={row.usage} missingUsage={row.missingUsage} models={models}
                      durationMs={anchor !== undefined && finished && before ? getTurnDurationMs(messages, anchor, before.index + 1) : undefined}
                      cacheMisses={cacheMissMarker ? summarizeCacheMisses(noticed) : undefined}
                      defaultExpanded={!before} reveal={reveal} renderDetails={() => row.items.map((item) => renderItem(item))} t={t} />;
                  },
                });
              }
              const { startIndex } = getVisibleRenderWindow(rendered.length, visibleCount);
              const hasMore = startIndex > 0 || hasEarlierMessages;
              return (
                <>
                  {hasMore && (
                     <div ref={setSentinel} className="py-3 text-center text-xs text-text-muted">
                       {t("chat.loadEarlier", { count: earlierTurnCount })}
                    </div>
                  )}
                  {rendered.slice(startIndex).map(({ key, pinned, render }, index) => (
                    <TranscriptViewportRow key={key} pinned={pinned || index + startIndex >= rendered.length - 2} render={render} />
                  ))}
                </>
              );
            })()}
            <StreamingReply store={streamingStore} onCommit={onStreamingCommit} toolResults={toolResultsMap} modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} tokenDisplay={tokenDisplay} waitingForModel={waitingForModel || (showTokenFlow && isStreaming)} model={displayModelValue} />

            {agentRunning && !hasStreamingContent && (agentPhase || isCompacting) && (
              <div className="break-words py-2 text-[13px] text-text-muted">
                {phaseLabel(agentPhase, t, isCompacting)}
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                {t("chat.runningCommand")}
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                onOpenSubagent={onOpenSubagent}
              />
            )}

            <div ref={promptAnchorSpacerRef} aria-hidden="true" />
            </div>
          </div>
        </div>
        </>}
      </div>

      {quoteSelectionEnabled && quotedSelection && createPortal(
        <div
          ref={quotePopoverRef}
          role={quoteInputOpen ? "dialog" : "toolbar"}
          aria-label={t(quoteInputOpen ? "chat.newQuoteChat" : "chat.askSelection")}
          style={{
            position: "fixed",
            top: quotedSelection.top,
            left: quotedSelection.left,
            zIndex: 260,
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
            width: quoteInputOpen ? "min(420px, calc(100vw - 16px))" : undefined,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
            overflowY: "auto",
            padding: quoteInputOpen ? 12 : 3,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
          }}
        >
          {quoteInputOpen ? (
            <fieldset
              disabled={quoteSubmitting}
              aria-busy={quoteSubmitting}
              style={{ width: "100%", minWidth: 0, margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600 }}>{t("chat.askInNewChat")}</span>
                <button type="button" className="file-viewer-icon-button" title={t("i18n.close")} aria-label={t("i18n.close")} disabled={quoteSubmitting} onClick={closeQuotedSelection} style={{ border: "none" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </div>
              <ChatInput
                ref={quoteChatInputRef}
                compact
                onSend={askSelectionInNewChat}
                onAbort={closeQuotedSelection}
                isStreaming={false}
              />
              {quoteError && <div role="alert" style={{ color: "#dc2626", fontSize: 12, overflowWrap: "anywhere" }}>{quoteError}</div>}
            </fieldset>
          ) : <>
          <button
            type="button"
            className="file-viewer-icon-button"
            title={t("chat.askInCurrent")}
            aria-label={t("chat.askInCurrent")}
            onPointerDown={(event) => event.preventDefault()}
            onClick={askSelectionHere}
            style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
          >
            <span aria-hidden="true" style={{ fontSize: 15 }}>@</span>
            <span>{t("chat.askInCurrent")}</span>
          </button>
          {onAskInNewChat && quotedSelection.sourceEntryId && !bashRunning && (
            <button
              type="button"
              className="file-viewer-icon-button"
              title={t("chat.askInNewChat")}
              aria-label={t("chat.askInNewChat")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => { setQuoteInputOpen(true); window.getSelection()?.removeAllRanges(); }}
              style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              </svg>
              <span>{t("chat.askInNewChat")}</span>
            </button>
          )}
          </>}
        </div>,
        document.body,
      )}

      <div className="relative shrink-0">
        {!isEmptyNew && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
              display: "flex",
              justifyContent: "center",
              paddingBottom: 10,
              pointerEvents: "none",
              zIndex: 20,
            }}
          >
            <button
              type="button"
              className={`chat-scroll-to-bottom${showScrollToBottom && !pendingScrollRestore ? " is-visible" : ""}`}
              title={t("chat.scrollToLatest")}
              aria-label={t("chat.scrollToLatest")}
              onClick={resumeAutoFollow}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
            </button>
          </div>
        )}
        {/* The brand (the omp wordmark and its versions line), then the
            project/worktree row right above the composer, all on the
            composer's left edge (.new-session-brand, .new-session-meta and
            .new-session-context in app/globals.css; the side padding and
            width are inline here). */}
        {isEmptyNew && (
          <div className="new-session-hero" style={{ paddingLeft: 16, paddingRight: isMobile ? 16 : 52 }}>
            <div className="new-session-hero-inner" style={{ maxWidth: "var(--chat-content-max-width, 820px)" }}>
              <div className="new-session-brand">
                <OmpWordmark markSize={40} />
                <div className="new-session-brand-text">
                  <span className="new-session-meta">
                    <span>web v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                    <NewSessionUpdateLink label={(version) => t("appUpdate.releaseNotes", { version })} />
                    <span aria-hidden="true">·</span>
                    <span className="new-session-meta-pi">omp v{process.env.NEXT_PUBLIC_OMP_VERSION ?? "0.0.0"}</span>
                  </span>
                </div>
              </div>
              {newSessionContextBar}
            </div>
          </div>
        )}
        <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <GoalBar goal={goalStatus} t={t} />
          </div>
        </div>
        <div className="relative">
          {chatInputElement}
          {chatAnimations && composerHandoff > 0 && <span key={composerHandoff} className="chat-composer-handoff" aria-hidden="true"
            onAnimationEnd={() => setComposerHandoff((turn) => turn === composerHandoff ? 0 : turn)} />}
        </div>
        <ExtensionStatusBar
          statuses={extensionStatuses}
          widgets={extensionWidgets}
          onCommand={handleSend}
          commandsDisabled={sessionBusy}
        />
      </div>
      {showTokenFlow && <svg ref={composerWireRef} className="token-flow-wire z-[1]" width="100%" height="100%" aria-hidden="true"><path /></svg>}
      {isEmptyNew && <div className="min-h-0 flex-1" />}
    </div>
    </ChatAnimationsContext>
  );
}

/**
 * Goal mode runs a continuation loop between turns, so the operator needs to
 * see that it is on and how much budget is left without asking for it.
 */
function GoalBar({ goal, t }: { goal: GoalStatusInfo | null; t: (key: string, params?: Record<string, string | number>) => string }) {
  if (!goal) return null;
  const paused = !goal.enabled;
  const budget = goal.tokenBudget !== undefined
    ? t("chat.goalBudgetLeft", { left: formatTokenCount(Math.max(0, goal.tokenBudget - goal.tokensUsed)) })
    : t("chat.goalTokensUsed", { used: formatTokenCount(goal.tokensUsed) });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 8,
        padding: "5px 10px",
        border: "1px solid var(--border)",
        borderRadius: 7,
        background: "var(--bg-panel)",
        color: "var(--text-muted)",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        opacity: paused ? 0.7 : 1,
      }}
    >
      <span style={{ color: paused ? "var(--text-dim)" : "var(--accent)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", flexShrink: 0 }}>
        {t("chat.goalLabel")}
      </span>
      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
        {goal.objective}
      </span>
      <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>
        {paused ? t("chat.goalPaused") : goal.status}
      </span>
      <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>{budget}</span>
    </div>
  );
}

// The reply being streamed: the one part of the chat a chunk re-renders.
const StreamingReply = memo(function StreamingReply({ store, onCommit, toolResults, modelNames, cwd, onOpenFile, onOpenSubagent, tokenDisplay, waitingForModel, model }: {
  store: StreamingStore;
  /** Runs after each visible update is in the DOM. */
  onCommit: (message: AssistantMessage | null) => void;
  toolResults: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  tokenDisplay: TokenDisplayMode;
  waitingForModel: boolean;
  model: { provider: string; modelId: string } | null;
}) {
  const { root, message } = useSequencedReply(store);
  const { t } = useI18n();
  useLayoutEffect(() => onCommit(message), [message, onCommit, waitingForModel]);
  const waitingMessage = useMemo<AssistantMessage>(() => ({
    role: "assistant",
    content: [],
    provider: model?.provider ?? "",
    model: model?.modelId ?? t("chat.waitingModel"),
  }), [model, t]);
  if (!waitingForModel && (!message || (!message.content.length && tokenDisplay !== "flow"))) return null;
  return <div ref={root} className="contents"><MessageView message={message ?? waitingMessage} toolResults={toolResults} isStreaming live
    modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} tokenDisplay={tokenDisplay} /></div>;
});

// A one-line notice is exactly as tall as its entrance animation pins it, and
// its line sits dead centre: the two 1px borders, a 21px line box (14px at
// line-height 1.5) and this padding twice add up to 60px. Letting the card's
// min-height take the leftover instead leaves the top-aligned text 4.5px above
// the centre, since the rest of the leftover stays under it.
const NOTICE_MIN_HEIGHT_PX = 60;
const NOTICE_LINE_BOX_PX = 21;
const NOTICE_TEXT_PADDING_Y_PX = (NOTICE_MIN_HEIGHT_PX - 2 - NOTICE_LINE_BOX_PX) / 2;
// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下边框（全局 box-sizing: border-box，
// 文本区的 max-height 已包含它自己的上下 padding，不能再减一次）
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 2;

function NoticeShelf({ notices, floating = false, onPauseChange }: { notices: NoticeItem[]; floating?: boolean; onPauseChange?: (id: string | null) => void }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Right-anchored: every toast's right edge aligns here, widths extend leftward
        alignItems: "flex-end",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            onMouseEnter={() => onPauseChange?.(notice.id)}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement)) onPauseChange?.(null);
            }}
            onFocus={() => onPauseChange?.(notice.id)}
            onBlur={(event) => {
              if (!event.currentTarget.matches(":hover")) onPauseChange?.(null);
            }}
            style={{
              display: "flex",
              // Top-align children so the type dot sits by the first line on multi-line toasts
              alignItems: "flex-start",
              gap: 10,
              minHeight: NOTICE_MIN_HEIGHT_PX,
              height: "auto",
              // 整体高度上限：超出后由文本区内部滚动承担（见下方 span 的 overflowY），
              // 容器自身保持 hidden，小圆点固定在顶部不随文本滚动
              maxHeight: NOTICE_MAX_HEIGHT_PX,
              // The floating wrapper is pointerEvents:"none" (click-through by design),
              // so the toast itself must opt back into interactivity or hover events never reach it
              pointerEvents: "auto",
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 14,
              lineHeight: 1.5,
              transformOrigin: "top right",
              // Use backwards fill for the entrance animation so height styles return to
              // inline styles once it finishes; otherwise the keyframe's fixed 60px would
              // stick around in fill mode and permanently clamp the expanded toast
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out backwards",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                // Align with the optical center of the first text line: the text's
                // vertical padding + (21px line box - 7px dot) / 2
                marginTop: NOTICE_TEXT_PADDING_Y_PX + 7,
              }}
            />
            {/* Full text by default: pre-line preserves \n (nowrap/normal collapse
                newlines into spaces) and long lines wrap instead of truncating;
                content taller than the cap scrolls inside the text area */}
            <span
              tabIndex={0}
              style={{ padding: `${NOTICE_TEXT_PADDING_Y_PX}px 0`, minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-line", wordBreak: "break-word" }}
            >
              {splitNoticeText(notice.message).map((part, partIndex) => part.kind === "art" ? (
                // A terminal QR code or bar (#755): every space kept, rows touching, and a
                // font stack whose first font has the blocks too (the bundled Noto subset
                // has none, so spaces and blocks would come from fonts of different widths).
                <span
                  key={partIndex}
                  style={{
                    display: "inline-block",
                    verticalAlign: "top",
                    maxWidth: "100%",
                    overflowX: "auto",
                    whiteSpace: "pre",
                    fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
                    lineHeight: 1,
                    color: "var(--text)",
                  }}
                >
                  {part.text}
                </span>
              ) : part.text)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "ask" | "form" | "plan_review" }
>;

function getExtensionDialogSummary(request: ExtensionDialogRequest): string | undefined {
  if (request.method === "select" && request.options.length > 0) return request.options[0];
  if (request.method === "confirm") {
    const firstLine = request.message.split("\n").find((line) => line.trim());
    return firstLine?.trim();
  }
  return undefined;
}

/** Corner brackets pointing outward; when expanded they point inward (restore). */
function ExtensionSizeIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {expanded
        ? <path d="M3.5 1v2.5H1M6.5 1v2.5H9M6.5 9v-2.5H9M3.5 9v-2.5H1" />
        : <path d="M1 3.5V1h2.5M6.5 1H9v2.5M9 6.5V9H6.5M3.5 9H1V6.5" />}
    </svg>
  );
}

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [selectedOptions, setSelectedOptions] = useState<Record<string, number[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [planFeedback, setPlanFeedback] = useState("");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setPlanFeedback("");
    setCustomAnswers({});
    if (request.method !== "ask") {
      setSelectedOptions({});
      return;
    }
    const recommended: Record<string, number[]> = {};
    for (const question of request.questions) {
      recommended[question.id] = question.recommended !== undefined
        && question.options[question.recommended] !== undefined
        ? [question.recommended]
        : [];
    }
    setSelectedOptions(recommended);
  }, [request]);
  const [collapsed, setCollapsed] = useState(false);
  // Dialogs open at the historical width and grow only when their own content cannot
  // fit (a code block or table that would scroll sideways), so no extension has to ask
  // for room. The maximize button is the user's own override for this dialog (#947).
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const toggleFull = useCallback(() => setFull((prev) => !prev), []);
  const [now, setNow] = useState(() => Date.now());
  const focusFirstOption = useCallback((element: HTMLDivElement | null) => element?.focus(), []);
  const summary = getExtensionDialogSummary(request);
  const remainingSeconds = request.expiresAt === undefined
    ? null
    : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  useLayoutEffect(() => {
    if (collapsed) return;
    const dialog = dialogRef.current;
    const body = bodyRef.current;
    if (!dialog || !body) return;
    let disposed = false;
    const fit = () => {
      if (disposed) return;
      const blocks = body.querySelectorAll<HTMLElement>("pre, .markdown-table-wrap");
      if (blocks.length === 0) return;
      const needed = fitExtensionDialogWidth(
        dialog.offsetWidth,
        Array.from(blocks, (block) => block.scrollWidth - block.clientWidth),
      );
      // Only ever grow: shrinking again would make the dialog jump while it is read.
      if (needed !== null) setFitWidth((prev) => (prev !== null && prev >= needed ? prev : needed));
    };
    fit();
    // Highlighted code replaces its plain fallback after the first paint, and a web
    // font can change glyph widths once it arrives.
    const mutations = new MutationObserver(fit);
    mutations.observe(body, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(fit);
    return () => {
      disposed = true;
      mutations.disconnect();
    };
  }, [collapsed]);

  useEffect(() => {
    if (request.expiresAt === undefined) return;
    // The server closes expired requests via extension_ui_closed.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);

  const countdown = remainingSeconds !== null && (
    <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionExpiresIn", { seconds: remainingSeconds })}
    </span>
  );

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };
  if (request.method === "form") {
    return <FormDialog request={request} onRespond={(response) => onRespond(request, response)} />;
  }

  if (request.method === "ask") {
    const canSubmit = request.questions.every((question) =>
      (selectedOptions[question.id]?.length ?? 0) > 0
      || (customAnswers[question.id]?.trim().length ?? 0) > 0);
    const toggleOption = (questionId: string, optionIndex: number, multi: boolean) => {
      setSelectedOptions((current) => {
        const selected = current[questionId] ?? [];
        const next = multi
          ? selected.includes(optionIndex)
            ? selected.filter((index) => index !== optionIndex)
            : [...selected, optionIndex]
          : [optionIndex];
        return { ...current, [questionId]: next };
      });
    };
    const submitAnswers = () => {
      if (!canSubmit) return;
      onRespond(request, {
        value: JSON.stringify({
          kind: "submit",
          results: request.questions.map((question) => {
            const customInput = customAnswers[question.id]?.trim();
            return {
              id: question.id,
              question: question.question,
              options: question.options.map((option) => option.label),
              multi: question.multi ?? false,
              selectedOptions: (selectedOptions[question.id] ?? [])
                .map((index) => question.options[index]?.label)
                .filter((option): option is string => option !== undefined),
              ...(customInput ? { customInput } : {}),
            };
          }),
        }),
      });
    };

    return (
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape") onRespond(request, { cancelled: true });
        }}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 90,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          background: "color-mix(in srgb, #000 26%, transparent)",
          backdropFilter: "blur(2px)",
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("chat.agentQuestion")}
          style={{
            display: "flex",
            flexDirection: "column",
            width: "min(720px, 100%)",
            maxHeight: "min(780px, calc(100dvh - 32px))",
            overflow: "hidden",
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg)",
            boxShadow: "0 24px 80px rgba(0,0,0,0.32)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
            <span
              aria-hidden="true"
              style={{
                display: "grid",
                placeItems: "center",
                width: 24,
                height: 24,
                borderRadius: 6,
                background: "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))",
                color: "var(--accent)",
                fontSize: 13,
                fontWeight: 750,
              }}
            >
              ?
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 680 }}>{t("chat.agentQuestion")}</div>
              <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 11 }}>{t("chat.agentQuestionHint")}</div>
            </div>
          </div>

          <div style={{ overflowY: "auto", padding: 16 }}>
            <div style={{ display: "grid", gap: 14 }}>
              {request.questions.map((question, questionIndex) => {
                const selected = selectedOptions[question.id] ?? [];
                return (
                  <section
                    key={question.id}
                    style={{
                      padding: 14,
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      background: "var(--bg-panel)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                      {question.header && (
                        <span style={{ color: "var(--accent)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                          {question.header}
                        </span>
                      )}
                      {request.questions.length > 1 && (
                        <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
                          {questionIndex + 1}/{request.questions.length}
                        </span>
                      )}
                    </div>
                    <div style={{ marginBottom: 10, color: "var(--text)", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>
                      {question.question}
                    </div>
                    <div
                      role={question.multi ? "group" : "radiogroup"}
                      aria-label={question.question}
                      style={{ display: "grid", gap: 7 }}
                    >
                      {question.options.map((option, optionIndex) => {
                        const checked = selected.includes(optionIndex);
                        const recommended = question.recommended === optionIndex;
                        return (
                          <button
                            key={`${question.id}:${optionIndex}`}
                            type="button"
                            role={question.multi ? "checkbox" : "radio"}
                            aria-checked={checked}
                            onClick={() => toggleOption(question.id, optionIndex, question.multi ?? false)}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "18px minmax(0, 1fr) auto",
                              alignItems: "start",
                              gap: 9,
                              width: "100%",
                              padding: "9px 10px",
                              border: `1px solid ${checked ? "color-mix(in srgb, var(--accent) 55%, var(--border))" : "var(--border)"}`,
                              borderRadius: 7,
                              background: checked ? "color-mix(in srgb, var(--accent) 8%, var(--bg))" : "var(--bg)",
                              color: "var(--text)",
                              cursor: "pointer",
                              textAlign: "left",
                            }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                display: "grid",
                                placeItems: "center",
                                width: 16,
                                height: 16,
                                marginTop: 1,
                                border: `1px solid ${checked ? "var(--accent)" : "var(--text-dim)"}`,
                                borderRadius: question.multi ? 4 : "50%",
                                background: checked ? "var(--accent)" : "transparent",
                                color: "#fff",
                                fontSize: 10,
                                lineHeight: 1,
                              }}
                            >
                              {checked && (question.multi ? (
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <polyline points="2 5.2 4.1 7.2 8 2.8" />
                                </svg>
                              ) : (
                                <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />
                              ))}
                            </span>
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: "block", fontSize: 12.5, fontWeight: checked ? 650 : 500 }}>{option.label}</span>
                              {option.description && (
                                <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
                                  {option.description}
                                </span>
                              )}
                              {checked && option.preview && (
                                <span style={{ display: "block", marginTop: 8, padding: "7px 8px", borderLeft: "2px solid var(--accent)", background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                                  {option.preview}
                                </span>
                              )}
                            </span>
                            {recommended && (
                              <span style={{ color: "var(--accent)", fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                                {t("chat.recommended")}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <input
                      value={customAnswers[question.id] ?? ""}
                      onChange={(event) => setCustomAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitAnswers();
                      }}
                      placeholder={t("chat.customAnswer")}
                      aria-label={t("chat.customAnswer")}
                      style={{
                        width: "100%",
                        height: 34,
                        marginTop: 9,
                        padding: "0 10px",
                        border: "1px solid var(--border)",
                        borderRadius: 7,
                        outline: "none",
                        background: "var(--bg)",
                        color: "var(--text)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                      }}
                    />
                  </section>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
            <button
              type="button"
              onClick={() => onRespond(request, { cancelled: true })}
              style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}
            >
              {t("chat.cancel")}
            </button>
            <button
              type="button"
              onClick={() => onRespond(request, { value: JSON.stringify({ kind: "chat" }) })}
              style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer" }}
            >
              {t("chat.chatAboutThis")}
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={submitAnswers}
              style={{
                padding: "7px 12px",
                border: "1px solid var(--accent)",
                borderRadius: 6,
                background: "var(--accent)",
                color: "#fff",
                cursor: canSubmit ? "pointer" : "not-allowed",
                opacity: canSubmit ? 1 : 0.45,
                fontWeight: 650,
              }}
            >
              {t("chat.submitAnswer")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (request.method === "plan_review") {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 90,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          background: "color-mix(in srgb, #000 30%, transparent)",
          backdropFilter: "blur(2px)",
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`plan-review-${request.id}`}
          style={{
            display: "flex",
            flexDirection: "column",
            width: "min(820px, 100%)",
            height: "min(820px, calc(100dvh - 32px))",
            overflow: "hidden",
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg)",
            boxShadow: "0 24px 80px rgba(0,0,0,0.34)",
          }}
        >
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ color: "var(--accent)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              {t("chat.planApproval")}
            </div>
            <div id={`plan-review-${request.id}`} style={{ marginTop: 4, color: "var(--text)", fontSize: 15, fontWeight: 680 }}>
              {request.title}
            </div>
            <div style={{ marginTop: 5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, overflowWrap: "anywhere" }}>
              {request.planFilePath}
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 20px" }}>
            <MarkdownBody>{request.planContent}</MarkdownBody>
          </div>

          <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
            <textarea
              value={planFeedback}
              onChange={(event) => setPlanFeedback(event.target.value)}
              placeholder={t("chat.planFeedback")}
              aria-label={t("chat.planFeedback")}
              style={{
                width: "100%",
                minHeight: 64,
                maxHeight: 150,
                padding: "9px 10px",
                border: "1px solid var(--border)",
                borderRadius: 7,
                outline: "none",
                resize: "vertical",
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginTop: 9 }}>
              <button
                type="button"
                onClick={() => onRespond(request, {
                  value: JSON.stringify({ action: "refine", feedback: planFeedback.trim() }),
                })}
                style={{ padding: "7px 11px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer" }}
              >
                {t("chat.refinePlan")}
              </button>
              <button
                type="button"
                onClick={() => onRespond(request, { value: JSON.stringify({ action: "approve" }) })}
                style={{ padding: "7px 12px", border: "1px solid var(--accent)", borderRadius: 6, background: "var(--accent)", color: "#fff", cursor: "pointer", fontWeight: 650 }}
              >
                {t("chat.approvePlan")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }


  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onRespond(request, { cancelled: true });
      }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          className="chat-attention"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(560px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {request.title}
          </span>
          {summary && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          {countdown}
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        ref={dialogRef}
        role="dialog"
        className="chat-attention"
        aria-label={request.title}
        style={{
          pointerEvents: "auto",
          // "Full" fills the content region above the composer: the overlay is inset:0 with
          // 20px padding, so 100% keeps that breathing room without covering the input.
          width: full ? "100%" : `min(${fitWidth ?? EXTENSION_DIALOG_BASE_WIDTH}px, 100%)`,
          maxHeight: full ? "100%" : "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 1, minHeight: 0, display: "flex", alignItems: "flex-start", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)", maxHeight: "50vh", overflowY: "auto" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Pi's TUI shows the title verbatim, newlines included; select/input have no
                separate message field, so extensions put multi-line text here. */}
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{request.title}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              <span>{t("chat.extensionRequest")}</span>
              {countdown}
            </div>
          </div>
          <button
            type="button"
            onClick={toggleFull}
            title={full ? t("chat.extensionRestoreSize") : t("chat.extensionMaximize")}
            aria-label={full ? t("chat.extensionRestoreSize") : t("chat.extensionMaximize")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <ExtensionSizeIcon expanded={full} />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            title={t("chat.extensionCollapse")}
            aria-label={t("chat.extensionCollapse")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        <div
          ref={bodyRef}
          style={{
            padding: 14,
            flex: "1 1 auto", minHeight: 0, overflowY: "auto",
          }}
        >
          {request.method === "confirm" && (
            <MarkdownBody>{request.message}</MarkdownBody>
          )}
          {request.method === "select" && (
            <div
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-extension-option]"));
                const index = buttons.indexOf(event.target as HTMLElement);
                if (index < 0) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0
                  : event.key === "End" ? buttons.length - 1
                  : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next].focus({ preventScroll: true });
                buttons[next].scrollIntoView({ block: "nearest" });
              }}
              style={{ display: "grid", gap: 8 }}
            >
              {request.options.map((option, index) => (
                <div
                  key={option}
                  role="button"
                  tabIndex={0}
                  data-extension-option
                  aria-label={option}
                  ref={index === 0 ? focusFirstOption : undefined}
                  onClick={() => onRespond(request, { value: option })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onRespond(request, { value: option });
                  }}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                    overflowWrap: "anywhere",
                    // Match the scroller's padding so keyboard navigation never parks the
                    // option flush against the edge, where whole-pixel scroll snapping and
                    // overflow clipping cut off its focus ring.
                    scrollMargin: 14,
                  }}
                >
                  <div inert>
                    <MarkdownBody>{option}</MarkdownBody>
                    {request.optionDetails?.[index]?.description && (
                      <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
                        {request.optionDetails[index].description}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submitValue();
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            autoFocus={request.method === "confirm" || (request.method === "select" && request.options.length === 0)}
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const summary = displayLines.find((line) => line.trim())?.trim();

  useEffect(() => {
    if (!collapsed) inputRef.current?.focus();
  }, [collapsed]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(920px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {t("chat.extensionPanel")}
          </span>
          {summary && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          pointerEvents: "auto",
          position: "relative",
          // The extension already wrapped its lines to the width it asked for; show them
          // whole when that is wider than the usual 920px instead of scrolling sideways.
          width: "max-content",
          minWidth: "min(920px, 100%)",
          maxWidth: "100%",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              title={t("chat.extensionCollapse")}
              aria-label={t("chat.extensionCollapse")}
              style={{
                display: "grid",
                placeItems: "center",
                width: 28,
                height: 28,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
            <button
              onClick={() => onInput(request, "\x03")}
              style={{
                padding: "5px 9px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
               {t("chat.close")}
            </button>
          </div>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            minHeight: 0,
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          <AnsiText text={displayLines.join("\n")} />
        </pre>
      </div>
      )}
    </div>
  );
}
