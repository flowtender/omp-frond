"use client";

import { memo, useState, useRef, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import Github from "@lobehub/icons/es/Github";
import Firecrawl from "@lobehub/icons/es/Firecrawl";
import Jina from "@lobehub/icons/es/Jina";
import compactStringify from "json-stringify-pretty-compact";
import ReactMarkdown from "react-markdown";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import { MarkdownBody } from "./MarkdownBody";
import { ImagePreview } from "./ImagePreview";
import { ThinkingIcon } from "./ThinkingIcon";
import { getFileIcon } from "./FileIcons";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePrismLanguages } from "@/hooks/usePrismLanguages";
import { fileLanguage } from "@/lib/file-language";
import { markdownRemarkPlugins } from "@/lib/markdown";
import { readToolPreview, type ReadToolPreview } from "@/lib/read-tool-display";
import { formatEvalJavaScript, formatEvalPython } from "@/lib/eval-code-format";
import { useToolDisplayPreference } from "@/hooks/useToolDisplayPreference";
import { usePythonFormatSettings } from "@/hooks/usePythonFormat";
import type { TokenDisplayMode } from "@/hooks/useTokenDisplay";
import { TokenFlow, TokenFlowHandoff } from "./TokenFlow";
import { TranscriptBlock } from "./TranscriptBlock";
import { TranscriptGrowth } from "./TranscriptGrowth";
import type { TranslationParams } from "@/lib/i18n/types";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { getAssistantErrorMessage, getThinkingPreview, hasAssistantAnswer, isAssistantTruncated, isEmptyThinkingBlock, isHiddenAssistantBlock, splitThinkingPieces } from "@/lib/message-display";
import { useDisplaySettings } from "@/hooks/useDisplaySettings";
import { formatTurnDuration } from "@/lib/turn-duration";
import { diffGapLabel, parseUnifiedPatch, type SplitDiffCell, type SplitDiffFile, type SplitDiffGap } from "@/lib/patch";
import { canHighlightDiff, highlightDiffFile, MAX_STREAMING_HIGHLIGHT_CHARS, type DiffToken } from "@/lib/diff-syntax";
import { applyPatchPreviewToFiles, applyPatchResultHasFailures, extractApplyPatchPaths, getApplyPatchInputText, parseApplyPatchInput } from "@/lib/apply-patch";
import { isApplyPatchToolName, isBashToolName, isEditToolName, isWriteToolName } from "@/lib/tool-names";
import { normalizeCustomPanelLines, parseAnsiLine, stripAnsi } from "@/lib/ansi";
import { isToolCallExpanded, setToolCallExpanded, toolCallExpandedByDefault, toolCallFailureCount } from "@/lib/tool-call-expansion";
import { useExpansionPreference } from "@/lib/expansion-preference";
import { TurnWrittenFiles } from "./TurnWrittenFiles";
import type { WrittenFile } from "@/lib/turn-written-files";
import { skillExpansionBody, skillExpansionToCommand } from "@/lib/slash-display";
import type { SubagentToolDetails } from "@/lib/subagent-extension";
import { CODEMODE_TOOL_NAME, codemodeCalls, codemodeScript, codemodeScriptPreview, stripCodemodeHeader } from "@/lib/codemode-view";
import { CodemodeCallList } from "./CodemodeToolView";
import { toolFieldsOfInput, type ToolField } from "@/lib/tool-fields";
import { mcpToolLabel, type McpToolLabel } from "@/lib/mcp-tool-display";
import { inlineToolResult, inlineToolTarget, ranToolNames, shellToolDispatches, type ToolDispatch } from "@/lib/inline-tool-display";
import { asyncResultCards, taskToolCards, type TaskResultCard } from "@/lib/task-tool-display";
import { smoothStreamRate, streamRateKey, streamRateStart, streamTokensPerSecond, type StreamRateStart } from "@/lib/stream-token-rate";
import type { AssistantTranscriptPart } from "@/lib/chat-transcript";
import type {
  AgentMessage,
  AgentUsage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";

// CJK chars ~1 token each (GLM/DeepSeek/GPT-o200k); other chars ~4 chars/token.
const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\uac00-\ud7af]/u;
function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk++;
    else rest++;
  }
  return cjk + rest / 4;
}

interface TokenEstimateCacheEntry {
  text: string;
  tokens: number;
}

export function getTokenEstimateText(block: AssistantContentBlock): string | null {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  if (block.type === "toolCall") return block.rawInput ?? JSON.stringify(block.input ?? {}) ?? "";
  return null;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function estimateUpdatedTokens(previous: TokenEstimateCacheEntry | undefined, text: string): number {
  if (!previous || !text.startsWith(previous.text)) return estimateTokens(text);

  let baseTokens = previous.tokens;
  let suffixStart = previous.text.length;
  // A streamed delta can complete a surrogate pair that was counted as two
  // non-CJK code points in the previous update.
  if (
    suffixStart > 0
    && suffixStart < text.length
    && isHighSurrogate(previous.text.charCodeAt(suffixStart - 1))
    && isLowSurrogate(text.charCodeAt(suffixStart))
  ) {
    baseTokens -= 1 / 4;
    suffixStart--;
  }
  return baseTokens + estimateTokens(text.slice(suffixStart));
}

const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();

// Messages larger than this skip markdown rendering entirely. react-markdown +
// KaTeX + syntax highlighting on multi-hundred-KB payloads (e.g. pasted HAR or
// log dumps) freezes the browser main thread.
const MAX_MARKDOWN_CHARS = 100_000;

// Tool text can be updated frequently and can contain huge outputs. Only load
// Prism for complete, bounded text with a known language.
const ToolSyntax = memo(function ToolSyntax({ text, language, streaming = false, inline = false }: {
  text: string;
  language?: string | null;
  streaming?: boolean;
  inline?: boolean;
}) {
  const enabled = !streaming && !!language && language !== "text" && text.length <= MAX_MARKDOWN_CHARS;
  const ready = usePrismLanguages(enabled);
  if (!enabled || !ready) return <>{text}</>;
  return <SyntaxHighlighter
    className="omp-syntax"
    language={language}
    useInlineStyles={false}
    PreTag="span"
    CodeTag="span"
    codeTagProps={{ className: `language-${language}`, style: { whiteSpace: inline ? "inherit" : "pre-wrap" } }}
  >{text}</SyntaxHighlighter>;
});

function jsonLanguage(text: string): string | null {
  if (text.length > MAX_MARKDOWN_CHARS || !/^\s*[\[{]/.test(text)) return null;
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return null;
  }
}

function toolNameIs(tool: string, name: string): boolean {
  const normalized = tool.toLowerCase();
  return normalized === name || normalized.endsWith(`.${name}`) || normalized.endsWith(`_${name}`);
}

function toolFileLanguage(args: Record<string, unknown>, details?: unknown): string | null {
  const path = (isRecord(details) && typeof details.resolvedPath === "string" ? details.resolvedPath : undefined)
    ?? (typeof args.path === "string" ? args.path : args.file_path);
  if (typeof path !== "string") return null;
  const language = fileLanguage(path.replace(/(?::(?:raw|[-\d,]+))+$/i, ""));
  return language === "text" || language === "pdf" || language === "word" ? null : language;
}

function toolFieldLanguage(tool: string, args: Record<string, unknown>, key: string): string | null {
  if (key === "pattern" && toolNameIs(tool, "grep")) return "regex";
  if (key === "content" && isWriteToolName(tool)) return toolFileLanguage(args);
  return null;
}

function toolOutputLanguage(tool: string, args: Record<string, unknown>, text: string, details?: unknown): string | null {
  return (toolNameIs(tool, "read") ? toolFileLanguage(args, details) : null) ?? jsonLanguage(text);
}

function formatMessageBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/**
 * MarkdownBody with an oversized-content guard: huge messages render as a
 * click-to-reveal plain-text <pre> instead of running the markdown pipeline.
 */
function SafeMarkdownBody({ children, className, ...props }: React.ComponentProps<typeof MarkdownBody>) {
  return children.length > MAX_MARKDOWN_CHARS
    ? <OversizedText className={className}>{children}</OversizedText>
    : <MarkdownBody className={className} {...props}>{children}</MarkdownBody>;
}

function OversizedText({ children, className }: { children: string; className?: string }) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (!showRaw) {
    return (
      <button
        onClick={() => setShowRaw(true)}
        style={{
          display: "block",
          width: "100%",
          margin: "4px 0",
          padding: "7px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        ⚠ {t("i18n.largeMessageReveal", { size: formatMessageBytes(children.length) })}
      </button>
    );
  }
  return (
    <div className={className} style={{ maxHeight: 420, overflow: "auto", fontSize: "calc(12px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
        }}
      >
        {children}
      </pre>
    </div>
  );
}

// Cap the user "sent" bubble's height so an abnormally long message does not
// push the conversation off screen; overflow scrolls inside the bubble.
const USER_BUBBLE_MAX_HEIGHT = 300;

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
  ).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { thinking?: unknown };
    if (typeof data.thinking !== "string") throw new Error("Invalid thinking response");
    return data.thinking;
  }).catch((error) => {
    thinkingContentCache.delete(key);
    throw error;
  });

  thinkingContentCache.set(key, request);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  live?: boolean;
  toolArrival?: boolean;
  arrivalSpark?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onEditContent?: (message: UserMessage, entryId: string) => void;
  onCancelEdit?: () => void;
  isEditing?: boolean;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  /**
   * Files this turn wrote, derived by the caller from the whole turn's
   * successful write/edit tool calls. ChatWindow computes this because the
   * saved-message path splits tool calls into their own entries, leaving the
   * final answer text-only.
   */
  writtenFiles?: WrittenFile[];
  /** The whole turn's time, for a final answer with no process details to show it. */
  turnDurationMs?: number;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  /** Leave the per-request cost out of the usage line (the session shows subscription usage instead). */
  hideCost?: boolean;
  transcriptPart?: AssistantTranscriptPart;
  pairedToolCalls?: ReadonlySet<string>;
  hideTokenCounts?: boolean;
  tokenDisplay?: TokenDisplayMode;
}

export function getModelDisplayName(
  provider: string,
  responseModel: string,
  modelNames?: Record<string, string>,
): string {
  const normalizedProvider = provider.toLowerCase();
  const normalizedResponse = responseModel.toLowerCase();
  const configured = Object.entries(modelNames ?? {}).flatMap(([key, name]) => {
    const separator = key.indexOf(":");
    return separator > 0 && key.slice(0, separator).toLowerCase() === normalizedProvider
      ? [{ id: key.slice(separator + 1).toLowerCase(), name }]
      : [];
  });
  return configured.find((model) => model.id === normalizedResponse)?.name
    ?? configured.find((model) => normalizedResponse.endsWith(`/${model.id}`))?.name
    ?? Object.entries(modelNames ?? {}).find(([key]) => key.toLowerCase() === normalizedResponse)?.[1]
    ?? `${provider}/${responseModel}`;
}

export function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

/** When a message's recorded work ended, for the flow handoff drawn beside it. */
export function handoffTimeOf(message: { timestamp?: number; durationMs?: unknown }): string | null {
  const durationMs = recordedDurationMs(message.durationMs);
  return message.timestamp && durationMs !== undefined ? formatTime(message.timestamp + durationMs) : null;
}

export function replaceUserMessageText(message: UserMessage, text: string): UserMessage {
  if (typeof message.content === "string") return { ...message, content: text };

  const content: Array<TextContent | ImageContent> = [];
  let replaced = false;
  for (const block of message.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (!replaced) {
      content.push({ ...block, text });
      replaced = true;
    }
  }
  if (!replaced) content.unshift({ type: "text", text });
  return { ...message, content };
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(function MessageView({ message, isStreaming, live, arrivalSpark, toolArrival, toolResults, modelNames, cwd, onOpenFile, onOpenSubagent, entryId, searchBlock, onFork, forking, onEditContent, onCancelEdit, isEditing, showTimestamp, prevTimestamp, sessionId, writtenFiles, turnDurationMs, onCompact, isCompacting, compactError, hideCost, tokenDisplay = "text", transcriptPart, pairedToolCalls, hideTokenCounts }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} live={arrivalSpark} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onEditContent={onEditContent} onCancelEdit={onCancelEdit} isEditing={isEditing} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} live={live} arrivalSpark={arrivalSpark} toolArrival={toolArrival} toolResults={toolResults} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} sessionId={sessionId} entryId={entryId} searchBlock={searchBlock} writtenFiles={writtenFiles} turnDurationMs={turnDurationMs} onCompact={onCompact} isCompacting={isCompacting} compactError={compactError} hideCost={hideCost} tokenDisplay={tokenDisplay} transcriptPart={transcriptPart} pairedToolCalls={pairedToolCalls} hideTokenCounts={hideTokenCounts} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} showFlow={tokenDisplay === "flow"} />;
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && prev.live === next.live
    && prev.arrivalSpark === next.arrivalSpark
    && prev.toolArrival === next.toolArrival
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.modelNames === next.modelNames
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.onOpenSubagent === next.onOpenSubagent
    && prev.entryId === next.entryId
    && prev.searchBlock === next.searchBlock
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.onEditContent === next.onEditContent
    && prev.onCancelEdit === next.onCancelEdit
    && prev.isEditing === next.isEditing
    && prev.showTimestamp === next.showTimestamp
    && prev.prevTimestamp === next.prevTimestamp
    && prev.writtenFiles === next.writtenFiles
    && prev.turnDurationMs === next.turnDurationMs
    && prev.sessionId === next.sessionId
    && prev.onCompact === next.onCompact
    && prev.isCompacting === next.isCompacting
    && prev.compactError === next.compactError
    && prev.hideCost === next.hideCost
    && prev.tokenDisplay === next.tokenDisplay
    && prev.transcriptPart === next.transcriptPart
    && prev.pairedToolCalls === next.pairedToolCalls
    && prev.hideTokenCounts === next.hideTokenCounts;
});

function UserMessageView({ message, live, cwd, onOpenFile, entryId, onFork, forking, onEditContent, onCancelEdit, isEditing }: {
  message: UserMessage;
  live?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onEditContent?: (message: UserMessage, entryId: string) => void;
  onCancelEdit?: () => void;
  isEditing?: boolean;
}) {
  const { t } = useI18n();
  const readPreviews = useToolDisplayPreference("readPreviews");
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Session files can hold `\r\n` or lone `\r` line endings (#680). Chrome renders
  // a lone `\r` as a space even in the pre-wrap command-args and raw-text views.
  // Copy uses this text too; the session file keeps the original endings.
  const content = (
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n")
  ).replace(/\r\n?/g, "\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const skillBody = readPreviews ? skillExpansionBody(content) : null;
  const commandText = skillExpansionToCommand(content);
  const commandSeparator = commandText?.search(/\s/) ?? -1;
  const commandName = commandText
    ? commandSeparator === -1 ? commandText : commandText.slice(0, commandSeparator)
    : "";
  const commandArgs = commandText && commandSeparator !== -1
    ? commandText.slice(commandSeparator + 1)
    : "";

  const time = formatTime(message.timestamp);
  const canFork = !!entryId && !!onFork;
  const copyTarget = commandText ?? content;
  const editTarget = commandText ? replaceUserMessageText(message, commandText) : message;

  const imageBlocksNode = imageBlocks.length > 0 && (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
      {imageBlocks.map((img, i) => {
        // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
        // pi-ai on-disk format uses flat {data, mimeType} — handle both
        const flat = img as unknown as { data?: string; mimeType?: string };
        const src = img.source
          ? img.source.type === "base64"
            ? `data:${img.source.media_type};base64,${img.source.data}`
            : img.source.url ?? ""
          : flat.data
            ? `data:${flat.mimeType};base64,${flat.data}`
            : "";
        return (
          <ImagePreview key={i} src={src}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid rgba(59,130,246,0.15)" }}
            />
          </ImagePreview>
        );
      })}
    </div>
  );
  const canEdit = !!entryId && !!onEditContent;
  const canCancelEdit = !!isEditing && !!onCancelEdit;

  const copyContent = () => {
    copyText(copyTarget).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className="transcript-message"
      style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <TranscriptBlock data-transcript-port="input" style={{ display: "flex", alignSelf: "stretch", justifyContent: "flex-end" }}>
        <div
          className="transcript-user-bubble"
          style={{
            maxWidth: "85%",
            background: isEditing ? "color-mix(in srgb, var(--accent) 14%, var(--user-bg))" : "var(--user-bg)",
            border: isEditing ? "1px solid color-mix(in srgb, var(--accent) 62%, var(--user-bg))" : "1px solid rgba(59,130,246,0.2)",
            boxShadow: isEditing ? "0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent)" : undefined,
            borderRadius: 12,
            padding: "8px 12px",
            fontSize: "calc(14px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
            maxHeight: USER_BUBBLE_MAX_HEIGHT,
            overflowY: "auto",
          }}
        >
          <CardSpark kind="input" active={live} />
          {commandText ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              {imageBlocksNode}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setExpanded((prev) => !prev)}
                  title={expanded ? t("i18n.collapse") : t("i18n.expand")}
                  aria-expanded={expanded}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                    padding: 0,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "calc(13px + var(--chat-font-size-offset, 0px))",
                    textAlign: "left",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {commandName}
                  </span>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0, opacity: 0.75, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {commandArgs && (
                  <span style={{
                    color: "var(--text)",
                    fontSize: "calc(14px + var(--chat-font-size-offset, 0px))",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minWidth: 0,
                    flex: 1,
                  }}>
                    {commandArgs}
                  </span>
                )}
              </div>
              {expanded && (
                skillBody === null
                  ? <SafeMarkdownBody className="markdown-user-message" keepLineBreaks cwd={cwd} onOpenFile={onOpenFile}>{content}</SafeMarkdownBody>
                  : <ToolDocument text={skillBody} />
              )}
            </div>
          ) : (
          <>
          {imageBlocksNode}
          {content && <SafeMarkdownBody className="markdown-user-message" keepLineBreaks cwd={cwd} onOpenFile={onOpenFile}>{content}</SafeMarkdownBody>}
          </>
          )}

        </div>

      </TranscriptBlock>

      {/* Bottom row: action buttons + timestamp */}
      {(time || canFork || canEdit || true) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 3,
        }}>
          <div style={{
            display: "flex", gap: 3,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 0.12s",
          }}>
            <button
              onClick={copyContent}
               title={t("i18n.copyMessage")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
          </div>
          {(canFork || canEdit || canCancelEdit) && (
            <div style={{
              display: "flex", gap: 3,
              opacity: (hovered || forking || canCancelEdit) ? 1 : 0,
              pointerEvents: (hovered || forking || canCancelEdit) ? "auto" : "none",
              transition: "opacity 0.12s",
            }}>
              {canEdit && !canCancelEdit && (
                <button
                  onClick={() => onEditContent!(editTarget, entryId!)}
                   title={t("i18n.editFromHereTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 10 20 15 15 20" />
                    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                  </svg>
                   {t("i18n.editFromHere")}
                </button>
              )}
              {canCancelEdit && (
                <button
                  type="button"
                  onClick={onCancelEdit}
                  title={t("i18n.cancel")}
                  aria-label={t("i18n.cancel")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: "var(--accent)",
                    cursor: "pointer",
                    fontSize: 11, fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                  {t("i18n.cancel")}
                </button>
              )}
              {canFork && (
                <button
                  onClick={() => { onFork!(entryId!); }}
                  disabled={forking}
                   title={forking ? t("i18n.creatingSession") : t("i18n.newSessionTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: forking ? "var(--accent)" : "var(--text-dim)",
                    cursor: forking ? "not-allowed" : "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                   {forking ? t("i18n.creating") : t("i18n.newSession")}
                </button>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
        </div>
      )}
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  live,
  arrivalSpark,
  toolArrival,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  onOpenSubagent,
  showTimestamp,
  prevTimestamp,
  sessionId,
  entryId,
  searchBlock,
  writtenFiles,
  turnDurationMs,
  onCompact,
  isCompacting,
  compactError,
  hideCost,
  tokenDisplay,
  transcriptPart,
  pairedToolCalls,
  hideTokenCounts,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  live?: boolean;
  arrivalSpark?: boolean;
  toolArrival?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  writtenFiles?: WrittenFile[];
  turnDurationMs?: number;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  hideCost?: boolean;
  tokenDisplay: TokenDisplayMode;
  transcriptPart?: AssistantTranscriptPart;
  pairedToolCalls?: ReadonlySet<string>;
  hideTokenCounts?: boolean;
}) {
  const { t } = useI18n();
  const { hideThinkingBlock } = useDisplaySettings();
  const time = useMemo(() => showTimestamp || tokenDisplay === "flow" ? formatTime(message.timestamp) : null, [message.timestamp, showTimestamp, tokenDisplay]);
  const start = transcriptPart?.start ?? 0;
  const end = transcriptPart?.end ?? message.content.length;
  const blockItems = useMemo(() => {
    const items = [];
    for (let originalIndex = start; originalIndex < end; originalIndex++) {
      const block = message.content[originalIndex];
      if (!isHiddenAssistantBlock(block, { isStreaming, hideThinking: hideThinkingBlock })) items.push({ block, originalIndex });
    }
    return items;
  }, [message.content, start, end, isStreaming, hideThinkingBlock]);
  const blocks = useMemo(() => blockItems.map(({ block }) => block), [blockItems]);
  const showStatus = !transcriptPart || transcriptPart.kind === "status";
  const providerError = showStatus ? getAssistantErrorMessage(message, { isStreaming }) : null;
  const truncated = showStatus && isAssistantTruncated(message, { isStreaming });
  const unansweredTruncation = truncated && !hasAssistantAnswer(message);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const rateKey = streamRateKey(message);
  const [tps, setTps] = useState<number | null>(null);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;
  const tokenEstimateCacheRef = useRef<Map<number, TokenEstimateCacheEntry>>(new Map());
  const estimatedTokens = useMemo(() => {
    if (!isStreaming) {
      tokenEstimateCacheRef.current = new Map();
      return 0;
    }
    const nextCache = new Map<number, TokenEstimateCacheEntry>();
    let total = 0;
    for (const { block, originalIndex } of blockItems) {
      const text = getTokenEstimateText(block);
      if (text === null) continue;
      const tokens = estimateUpdatedTokens(tokenEstimateCacheRef.current.get(originalIndex), text);
      nextCache.set(originalIndex, { text, tokens });
      total += tokens;
    }
    tokenEstimateCacheRef.current = nextCache;
    return total;
  }, [blockItems, isStreaming]);
  const estimatedTokensRef = useRef(estimatedTokens);
  estimatedTokensRef.current = estimatedTokens;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration of a completed message: the whole response's generation time, which pi
  // records since 1.1 (`durationMs`, from the request's start). Older messages only have
  // timestamps: the time since the previous message.
  const messageDurationMs = message.role === "assistant" ? recordedDurationMs(message.durationMs) : undefined;
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    const ms = messageDurationMs ?? (message.timestamp && prevTimestamp ? message.timestamp - prevTimestamp : undefined);
    if (ms === undefined) return undefined;
    const secs = Math.round(ms / 1000);
    return secs > 0 ? secs : undefined;
  }, [messageDurationMs, message.timestamp, prevTimestamp]);

  // Tool call durations in milliseconds: the execution time pi records on each result since 1.1,
  // as the pi CLI's "Took" shows it. An older result only has timestamps, the result's minus this
  // message's (when its request started), which counts the model's generation too.
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults) return map;
    for (const { block } of blockItems) {
      if (block.type !== "toolCall") continue;
      const callId = block.toolCallId;
      const result = toolResults.get(callId);
      if (!result) continue;
      const ms = recordedDurationMs(result.durationMs)
        ?? (result.timestamp && message.timestamp ? result.timestamp - message.timestamp : undefined);
      if (ms !== undefined && ms >= TOOL_DURATION_MIN_MS) map.set(callId, ms);
    }
    return map;
  }, [toolResults, message.timestamp, blockItems]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      setTps(null);
      return;
    }
    let start: StreamRateStart | null = null;
    let smoothedRate: number | null = null;
    let rateAt = 0;
    setTps(null);
    const tick = () => {
      const items = blockItemsRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      const tokens = estimatedTokensRef.current;
      if (tokens === 0) return;
      start ??= streamRateStart(rateKey, tokens, now);
      const rate = streamTokensPerSecond(start, tokens, now);
      if (rate !== null) {
        smoothedRate = smoothStreamRate(smoothedRate, rate, now - rateAt);
        rateAt = now;
        setTps(Math.round(smoothedRate * 10) / 10);
      }
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming, rateKey]);

  const showFlow = !transcriptPart && tokenDisplay === "flow" && (isStreaming || Boolean(message.usage));
  const modelName = message.provider ? getModelDisplayName(message.provider, message.model, modelNames) : message.model;
  const hasLiveOutput = live && blocks.some((block) => block.type !== "text" || block.text.trim());
  const flow = showFlow ? (
    <TokenFlow usage={isStreaming ? undefined : message.usage} provider={message.provider} model={message.model} modelName={modelName}
      estimatedOutput={isStreaming && estimatedTokens > 0 ? Math.round(estimatedTokens) : undefined} tokensPerSecond={isStreaming ? tps : undefined}
      time={time} live={live ? (hasLiveOutput ? "output" : "waiting") : undefined} />
  ) : null;
  const isCallPart = transcriptPart?.kind === "call";
  const toolBlocks = tokenDisplay === "flow" && !isStreaming && (!transcriptPart || isCallPart)
    ? blockItems.filter((item): item is typeof item & { block: ToolCallContent } => item.block.type === "toolCall")
    : undefined;
  const hasToolHandoff = Boolean(toolBlocks?.length);
  const handoffTime = hasToolHandoff ? handoffTimeOf(message) : null;
  if (blocks.length === 0 && !isStreaming && !providerError && !truncated && !transcriptPart?.metadata) return flow ?? null;
  const usageText = !isStreaming && message.usage && (!transcriptPart || transcriptPart.metadata)
    ? formatUsage(message.usage, hideCost, tokenDisplay === "text" && !hideTokenCounts) : "";
  const lastBlock = blockItems.at(-1);
  const renderBlock = ({ block, originalIndex }: typeof blockItems[number]) => {
    if (block.type !== "toolCall") return <BlockView key={originalIndex} block={block} searchTarget={block === searchBlock} isStreaming={isStreaming}
      outputSpark={isStreaming || arrivalSpark}
      thinkingSpark={isStreaming && originalIndex === lastBlock?.originalIndex}
      streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)}
      cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} />;
    if (isCallPart && pairedToolCalls?.has(block.toolCallId)) return null;
    return <TranscriptBlock key={originalIndex} data-transcript-port={isCallPart ? "input" : undefined}><BlockView block={block} toolResults={toolResults} toolArrival={toolArrival || live} toolCallDurations={toolCallDurations} cwd={cwd} onOpenSubagent={onOpenSubagent} blockIndex={originalIndex} /></TranscriptBlock>;
  };

  const outputBlocks = (
    <div className="flex flex-col gap-2" data-transcript-port={!live && isStreaming && blockItems.length > 0 ? "output" : undefined}>
      {/* Keep block state when a reconciled message gets a saved entry id (#1184). */}
      {blockItems.map((item) => hasToolHandoff && item.block.type === "toolCall" ? null : renderBlock(item))}
    </div>
  );

  return (
    <div
      data-message-role="assistant"
      className="transcript-message"
      data-entry-id={entryId}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {flow}
      {/* Model label */}
      {!flow && (!transcriptPart || (transcriptPart.metadata && tokenDisplay !== "flow")) && <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>{modelName}</span>
        )}
        {isStreaming && (() => {
          const est = Math.round(estimatedTokens);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("i18n.estimatedTokens")}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: 11, fontWeight: 400 }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>}

      {live ? (
        <TranscriptGrowth live={lastBlock?.block.type !== "toolCall"} from={0}
          data-transcript-port={hasLiveOutput ? "output" : undefined}>
          {outputBlocks}
        </TranscriptGrowth>
      ) : outputBlocks}

      {providerError && (
        <TranscriptBlock kind="response"
          role="alert"
          style={{
            marginTop: blocks.length > 0 ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 6,
            background: "rgba(239,68,68,0.07)",
            color: "#ef4444",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          Error: {providerError}
        </TranscriptBlock>
      )}

      {truncated && (
        <TranscriptBlock kind="response"
          role="alert"
          style={{
            marginTop: blocks.length > 0 || providerError ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(234,179,8,0.3)",
            borderRadius: 6,
            background: "rgba(234,179,8,0.07)",
            color: "#ca8a04",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {t(unansweredTruncation ? "chat.truncatedWithoutAnswer" : "chat.truncatedByOutputLimit")}
          {unansweredTruncation && onCompact && (
            <button
              type="button"
              onClick={onCompact}
              disabled={isCompacting}
              style={{
                display: "block",
                marginTop: 8,
                padding: "3px 8px",
                border: "1px solid currentColor",
                borderRadius: 5,
                background: "transparent",
                color: "inherit",
                cursor: isCompacting ? "default" : "pointer",
                font: "inherit",
              }}
            >
              {t(isCompacting ? "chat.compacting" : "chat.compactContext")}
            </button>
          )}
          {unansweredTruncation && compactError && (
            <div style={{ marginTop: 8, color: "#ef4444", whiteSpace: "pre-wrap" }}>{compactError}</div>
          )}
        </TranscriptBlock>
      )}
      {toolBlocks && toolBlocks.length > 0 && (
        <>
          <TokenFlowHandoff kind="tools" label={`${toolBlocks.length} ${t(toolBlocks.length === 1 ? "chat.toolCall" : "chat.toolCalls")}`} time={handoffTime}>
            {toolBlocks.flatMap(({ block, originalIndex }) =>
              ranToolNames(block.toolName, toolResults?.get(block.toolCallId)?.details).map((ranName, slot) => (
                <span key={`${originalIndex}:${slot}`} className="token-flow-handoff-icon" title={ranName}
                  data-chat-tool-state={toolMotion(toolResults?.get(block.toolCallId)?.liveTiming)}>
                  <span className="sr-only">{ranName}</span>
                  <ToolBlockIcon toolName={ranName} mcpLabel={mcpToolLabel(ranName)} isError={false} />
                </span>
              )))}
          </TokenFlowHandoff>
          <div className="flex flex-col gap-2">{toolBlocks.map(renderBlock)}</div>
        </>
      )}

      <div className="transcript-reply-footer" style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4,
      }}>
        {(usageText || turnDurationMs !== undefined) && !isStreaming && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {[
              usageText,
              turnDurationMs !== undefined ? t("chat.turnDuration", { time: formatTurnDuration(turnDurationMs) }) : null,
            ].filter(Boolean).join(" \u00b7 ")}
          </div>
        )}
        <div className="transcript-reply-actions">
        {writtenFiles && writtenFiles.length > 0 && <TurnWrittenFiles files={writtenFiles} onOpenFile={onOpenFile} />}
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
             title={t("i18n.copyMessage")}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 8px", height: 22,
              background: "none", border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11, fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
             {copied ? t("i18n.copied") : t("i18n.copy")}
          </button>
        )}
        {showTimestamp && time && !isStreaming && !hasToolHandoff && tokenDisplay !== "flow" && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
        </div>
      </div>
    </div>
  );
}

function CardSpark({ kind, active, repeat }: { kind: "input" | "output"; active?: boolean; repeat?: boolean }) {
  const [started, setStarted] = useState(Boolean(active));
  const [lap, setLap] = useState(0);
  if (active && !started) setStarted(true);
  if (!active && !started) return null;
  return <svg className="chat-card-spark" data-card-spark={kind} aria-hidden="true">
    <rect key={lap} x="1" y="1" pathLength="100" onAnimationEnd={repeat ? () => setLap(lap + 1) : undefined} />
  </svg>;
}

function BlockView({ block, searchTarget, toolResults, isStreaming, outputSpark, thinkingSpark, toolArrival, streamingDuration, toolCallDurations, cwd, onOpenFile, onOpenSubagent, sessionId, entryId, blockIndex }: { block: AssistantContentBlock; searchTarget?: boolean; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; outputSpark?: boolean; thinkingSpark?: boolean; toolArrival?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void; onOpenSubagent?: (sessionId: string, label: string) => void; sessionId?: string; entryId?: string; blockIndex: number }) {
  if (block.type === "text") {
    if (!block.text.trim()) return null;
    return <TranscriptBlock kind="response" className="chat-reply-card" data-transcript-port={isStreaming ? undefined : "output"} data-message-text data-search-target={searchTarget || undefined}>
      <TextBlock block={block} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} />
      <CardSpark kind="output" active={outputSpark} />
    </TranscriptBlock>;
  }
  if (block.type === "thinking") {
    return <TranscriptBlock kind="response" className="chat-thinking-card" data-transcript-port={isStreaming ? undefined : "output"}>
      <ThinkingBlock block={block} duration={streamingDuration} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} />
      <CardSpark kind="output" active={outputSpark} repeat={thinkingSpark} />
    </TranscriptBlock>;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const snapshot = toolResults?.get(tc.toolCallId);
    const liveTiming = snapshot?.liveTiming;
    const result = snapshot && liveTiming && liveTiming.endedAt === undefined && !snapshot.details && snapshot.content.length === 0
      ? undefined : snapshot;
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} liveTiming={liveTiming} toolArrival={toolArrival} cwd={cwd} onOpenSubagent={onOpenSubagent} />;
  }
  if (block.type === "image") {
    const src = imageSource(block);
    if (!src) return null;
    return (
      <TranscriptBlock kind="response" className="chat-reply-card" data-transcript-port={isStreaming ? undefined : "output"} data-search-target={searchTarget || undefined}>
        <ImagePreview src={src} style={{ maxWidth: "100%" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" loading="lazy" style={{ display: "block", maxWidth: "100%", maxHeight: 520, objectFit: "contain", borderRadius: 6 }} />
        </ImagePreview>
        <CardSpark kind="output" active={outputSpark} />
      </TranscriptBlock>
    );
  }
  return null;
}

function TextBlock({ block, isStreaming, cwd, onOpenFile }: { block: TextContent; isStreaming?: boolean; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void }) {
  return <SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody>;
}

// A model looping in its thinking can write megabytes. As one text node, every
// streamed chunk laid all of it out again (the prompt anchor reads layout after
// each commit). As pieces, only the last one changes. Thinking that fits one
// piece stays one text node.
export function ThinkingText({ text }: { text: string }) {
  const pieces = useMemo(() => splitThinkingPieces(text), [text]);
  if (pieces.length === 1) return text;
  // No memo: React already skips a div whose text is unchanged, and a memo
  // bailout keeps the old props, each a slice pinning the whole thinking of
  // its chunk (995 MB retained streaming 2M Chinese characters).
  return pieces.map((piece, index) => <div key={index}>{piece.text}</div>);
}

function useBlockExpansion(kind: "thinking" | "compaction") {
  const preference = useExpansionPreference(kind);
  const [manual, setManual] = useState<boolean>();
  const expanded = manual ?? (preference === "expanded");
  return [expanded, () => setManual(!expanded)] as const;
}

export function ThinkingBlock({ block, duration, sessionId, entryId, blockIndex }: {
  block: ThinkingContent;
  duration?: number;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const [expanded, toggleExpanded] = useBlockExpansion("thinking");
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(block.deferred === true);
  const [error, setError] = useState<string | null>(null);
  // The block outlives a change of entry id (a message of this run gets its id
  // when the file is read again, #1184): what was loaded for another entry goes.
  const loadKey = `${sessionId}:${entryId}:${blockIndex}`;
  const [loadedKey, setLoadedKey] = useState(loadKey);
  if (loadedKey !== loadKey) {
    setLoadedKey(loadKey);
    setContent(null);
    setLoading(false);
    setError(null);
  }
  const tRef = useRef(t);
  tRef.current = t;
  const preview = getThinkingPreview(block.thinking);

  // Load deferred history content whenever the block is expanded.
  // loadThinkingContent() memoizes in-flight promises and drops failed ones
  // from its cache, so re-running this effect is cheap and a failed load can
  // be retried by collapsing and expanding the block again.
  useEffect(() => {
    if (!expanded || !block.deferred || content !== null) return;
    if (!sessionId || !entryId) {
      setError(tRef.current("i18n.thinkingUnavailable"));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadThinkingContent(sessionId, entryId, blockIndex)
      .then((value) => {
        if (!cancelled) {
          setContent(value);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, block.deferred, content, sessionId, entryId, blockIndex]);

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0,
      border: "1px solid color-mix(in srgb, var(--text) 30%, var(--bg))",
      borderRadius: 7,
      padding: "6px 10px",
      background: "var(--bg)",
      fontFamily: "var(--font-mono)",
      fontSize: "calc(11px + var(--chat-font-size-offset, 0px))",
      lineHeight: 1.5,
    }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${t("i18n.thinking")}${preview ? `: ${preview}` : ""}`}
        title={t("i18n.thinking")}
        onClick={toggleExpanded}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          width: expanded ? 14 : "100%",
          flexShrink: expanded ? 0 : 1,
          minWidth: 0,
          minHeight: "1.5em",
          padding: 0,
          background: "transparent",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <ThinkingIcon active={expanded} />
        {!expanded && (
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {preview ? <ReactMarkdown allowedElements={[]} unwrapDisallowed skipHtml>{preview}</ReactMarkdown> : "..."}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            flex: 1,
            minWidth: 0,
            color: error ? "#f87171" : "var(--text-muted)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
           {loading ? t("i18n.loadingThinking") : error ?? <ThinkingText text={(block.deferred ? content : block.thinking) ?? ""} />}
        </div>
      )}
      {duration !== undefined && (
        <span style={{ flexShrink: 0, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
      )}
    </div>
  );
}

function isSubagentToolDetails(value: unknown): value is SubagentToolDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<SubagentToolDetails>;
  return details.kind === "pi-web-subagent" && typeof details.sessionId === "string";
}

/** A duration pi recorded on a message, or undefined when there is none to trust. */
function recordedDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Below this a tool card shows no time: it would read 0.0s on every quick read or search. */
const TOOL_DURATION_MIN_MS = 100;

/** A tool's run time as the pi CLI's "Took" writes it: 2.4s, then 3m 5s, then 1h 2m 5s. */
export function formatToolDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

export function TranscriptToolResult({ result, call, requestTime, cwd, onOpenSubagent, live }: {
  result: ToolResultMessage;
  call?: ToolCallContent;
  requestTime?: number;
  cwd?: string;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  live?: boolean;
}) {
  const duration = recordedDurationMs(result.durationMs)
    ?? (result.timestamp && requestTime ? result.timestamp - requestTime : undefined);
  return (
    <TranscriptBlock className="transcript-message" data-transcript-port="input">
      {call ? <ToolCallBlock block={call} result={result} cwd={cwd} onOpenSubagent={onOpenSubagent} arrived={live}
        duration={duration !== undefined && duration >= TOOL_DURATION_MIN_MS ? duration : undefined} />
        : <TranscriptGrowth toolArrival={live} data-chat-tool-state={live ? result.isError ? "failed" : "done" : undefined}>
          <ToolCard callId={result.toolCallId} toolName={result.toolName ?? "tool"} isError={Boolean(result.isError)} spark={live}>
            {() => <>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap">{getMessageText(result.content)}</pre>
              {getMessageImages(result.content).map((image, index) => {
                const src = imageSource(image);
                return src ? <ImagePreview key={index} src={src}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" loading="lazy" className="max-h-80 max-w-full" />
                </ImagePreview> : null;
              })}
            </>}
          </ToolCard>
        </TranscriptGrowth>}
    </TranscriptBlock>
  );
}

interface ToolCallBlockProps {
  block: ToolCallContent;
  result?: ToolResultMessage;
  duration?: number;
  liveTiming?: ToolResultMessage["liveTiming"];
  cwd?: string;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  arrived?: boolean;
  toolArrival?: boolean;
}

function toolMotion(timing: ToolResultMessage["liveTiming"], arrived?: boolean, failed?: boolean) {
  if (timing && timing.endedAt === undefined) return "running";
  if (timing || arrived) return failed ? "failed" : "done";
}

function ToolCallBlock(props: ToolCallBlockProps) {
  const { block, result, liveTiming, arrived, toolArrival } = props;
  const failed = toolCallFailureCount(block, result) > 0;
  return (
    <TranscriptGrowth live={Boolean(liveTiming)} toolArrival={toolArrival || arrived}
      data-chat-tool-state={toolMotion(liveTiming, arrived, failed)}>
      <ToolCallBody {...props} hasFailure={failed} />
    </TranscriptGrowth>
  );
}

function ToolCallBody({ block, result, duration, liveTiming, cwd, onOpenSubagent, hasFailure, toolArrival, arrived }: ToolCallBlockProps & { hasFailure: boolean }) {
  const { t } = useI18n();
  const compactJson = useToolDisplayPreference("compactJson");
  const readPreviews = useToolDisplayPreference("readPreviews");
  const isStreamingInput = block.rawInput !== undefined;
  const spark = Boolean(toolArrival || arrived || liveTiming || isStreamingInput);
  const isEditTool = isEditToolName(block.toolName);
  const repeatSpark = isStreamingInput && (isEditTool || isApplyPatchToolName(block.toolName) || isWriteToolName(block.toolName));
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;
  const patchFiles = getApplyPatchFiles(block, result);
  const patchLabel = isApplyPatchToolName(block.toolName)
    ? summarizeApplyPatchInput(block)
    : null;
  // A script and the calls it made, instead of the input JSON. Streamed input is
  // still incomplete JSON and keeps the generic view.
  const codemodeCode = block.toolName === CODEMODE_TOOL_NAME && !isStreamingInput ? codemodeScript(block.input) : null;
  const codemode = codemodeCode === null ? null : { code: codemodeCode, ...codemodeCalls(result?.details) };
  // A running script's progress snapshot has calls but no content yet.
  const codemodeRunning = codemode !== null && result !== undefined && result.content.length === 0;

  // `server/tool` instead of the registered `mcp__server__tool`, as pi's TUI shows it.
  const mcpLabel = mcpToolLabel(block.toolName, result?.details);

  // Result display
  const resultContent = result ? (codemode ? stripCodemodeHeader(result.content) : result.content) : [];
  const resultText = result
    ? resultContent.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultImages = getMessageImages(resultContent);
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = (result?.isError ?? false)
    || (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(result?.details));
  const inputView: ToolInputView = isStreamingInput ? { args: block.input } : describeToolInput(block.toolName, block.input, t);
  const args = inputView.args;
  const readPreview = !isError && !isStreamingInput && resultText !== null && resultText.length <= MAX_MARKDOWN_CHARS
    && toolNameIs(block.toolName, "read") ? readToolPreview(resultText, args.path ?? args.file_path, result?.details, readPreviews) : null;
  const readTarget = toolNameIs(block.toolName, "read") && !isStreamingInput
    ? readPreview?.url ?? readHeaderTarget(args)
    : undefined;
  const visibleArgs = readTarget ? omitShownReadPath(args, readTarget) : args;
  const toolFields = !isStreamingInput && codemode === null && patchFiles === null
    ? toolFieldsOfInput(visibleArgs)
    : null;
  const subagent = isSubagentToolDetails(result?.details) ? result.details : null;
  const codemodeCallCount = codemode ? codemode.calls.length + codemode.omitted : 0;
  // omp keeps a live console card for bash and a checklist card for todo.
  const normalizedToolName = block.toolName.toLowerCase();
  const isBashTool = isBashToolName(normalizedToolName);
  const isTodoTool = normalizedToolName === "todo" || normalizedToolName.endsWith(".todo") || normalizedToolName.endsWith("_todo");
  const todoPhases = isTodoTool && !isStreamingInput ? getTodoPreviewPhases(block, result) : null;

  if (isBashTool && !isStreamingInput) {
    const dispatches = shellToolDispatches(result?.details);
    if (dispatches.length > 0) {
      return <MountedToolCards
        callId={block.toolCallId}
        cwd={cwd}
        dispatches={dispatches}
        result={result}
        command={typeof block.input.command === "string" ? block.input.command : ""}
        output={resultText ?? ""}
        isError={isError}
        hasFinalTiming={isRecord(result?.details) && typeof result.details.wallTimeMs === "number"}
        duration={recordedDurationMs(result?.durationMs) ?? (isRecord(result?.details) ? recordedDurationMs(result.details.wallTimeMs) : undefined) ?? duration}
        liveTiming={liveTiming}
        spark={spark}
      />;
    }
    return (
      <ConsoleOutputPreview
        callId={block.toolCallId}
        command={isRecord(block.input) && typeof block.input.command === "string" ? block.input.command : ""}
        output={resultText ?? ""}
        pending={!result || (liveTiming !== undefined && liveTiming.endedAt === undefined)}
        spark={spark}
        isError={isError}
        duration={duration}
        liveTiming={liveTiming}
        local={normalizedToolName.includes("(local)")}
      />
    );
  }

  if (todoPhases) {
    return <ToolCard callId={block.toolCallId} toolName={block.toolName} isError={isError} spark={spark}>
      {(expanded) => expanded && <TodoChecklistPreview phases={todoPhases} />}
    </ToolCard>;
  }
  const inlineResult = inlineToolResult(block.toolName, result?.details, t);
  const inlineTarget = /^(?:memory_edit|retain|reflect|mcp__.*)$/.test(block.toolName)
    ? inlineToolTarget(block.toolName, block.input) : "";

  return (
    <ToolCard
      callId={block.toolCallId}
      toolName={block.toolName}
      spark={spark}
      mcpLabel={mcpLabel}
      repeatSpark={repeatSpark}
      isError={isError}
      hasFailure={hasFailure}
      target={isStreamingInput
        ? t("chat.generatingToolInput")
        : (readTarget ?? patchLabel ?? (codemode ? codemodeScriptPreview(codemode.code) : inputView.target ?? (inlineTarget || getStructuredToolPreview(block, todoPhases))))}
      targetLanguage={inputView.targetLanguage}
      facts={inlineResult}
      metadata={readPreviews && readPreview && <ReadHeaderMetadata preview={readPreview} target={readTarget} />}
      labelBadge={inputView.labelBadge}
      timeout={inputView.timeout}
      badge={inputView.badge}
      duration={toolNameIs(block.toolName, "eval") ? recordedDurationMs(result?.durationMs) ?? duration : duration}
      liveTiming={liveTiming}
      count={codemodeCallCount}
      action={subagent && onOpenSubagent && (
          <button
            type="button"
            onClick={() => onOpenSubagent(subagent.sessionId, subagent.description || subagent.profile)}
            title={t("subagent.openTab")}
            aria-label={t("subagent.openTab")}
            style={{ width: 32, display: "grid", placeItems: "center", border: "none", borderLeft: "1px solid var(--border)", background: "none", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" /></svg>
          </button>
      )}
    >
      {(expanded) => <>
      {/* ── Expanded: input args (only when no richer view exists); a codemode script in place of its JSON ── */}
      {expanded && (isStreamingInput || !isEditTool) && !patchFiles && (isStreamingInput || codemode || Object.keys(visibleArgs).length > 0) && (
        toolFields ? (
          <div
            style={{
              padding: "6px 10px 8px",
              background: "var(--bg-subtle)",
              borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            }}
          >
            <ToolFieldRows fields={toolFields} tool={block.toolName} args={block.input} />
          </div>
        ) : (
          <pre
            style={{
              margin: 0,
              padding: "8px 10px",
              color: "var(--text-muted)",
              fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
              lineHeight: 1.5,
              overflow: "auto",
              background: "var(--bg-subtle)",
              borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            <ToolSyntax text={codemode ? codemode.code.replace(/\r/g, "").trimEnd()
              : getToolCallInputText(block, compactJson, visibleArgs)}
              language={codemode ? "javascript" : "json"}
              streaming={isStreamingInput && ((!isEditTool && !isApplyPatchToolName(block.toolName))
                || (block.rawInput?.length ?? 0) > MAX_STREAMING_HIGHLIGHT_CHARS)} />
          </pre>
        )
      )}
      {expanded && inputView.fileContent !== undefined && <WrittenToolCode text={inputView.fileContent} args={block.input} />}
      {expanded && inputView.evalCode && <EvalToolCode {...inputView.evalCode} cwd={cwd} />}

      {/* ── Expanded: the calls a codemode script made ── */}
      {expanded && codemode && (
        <CodemodeCallList calls={codemode.calls} omitted={codemode.omitted} isError={isError} />
      )}

      {/* ── Result images — always visible, independent of the collapsed details ── */}
      {resultImages.length > 0 && <ResultImages images={resultImages} isError={isError} />}

      {/* ── Expanded: applied-patch split diff ── */}
      {expanded && patchFiles && (
        <div style={{ borderTop: "1px solid rgba(34,197,94,0.15)", background: "var(--bg)" }}>
          <SplitFilesView files={patchFiles} streaming={isStreamingInput} />
        </div>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && patchFiles && isError && (
        <PairedResult
          text={resultText ?? ""}
          isEmpty={resultIsEmpty}
          isError={isError}
        />
      )}
      {expanded && result && !patchFiles && !codemodeRunning && (
        resultDiff ? (
          <PairedDiffResult
            diff={resultDiff}
            targetPath={typeof block.input.path === "string" ? block.input.path : typeof block.input.file_path === "string" ? block.input.file_path : undefined}
            streaming={isStreamingInput}
          />
        ) : (!resultIsEmpty || resultImages.length === 0) && (
          <TaskResultOutput callId={block.toolCallId} tool={block.toolName} result={result} output={resultText ?? ""}>
            <PairedResult text={resultText ?? ""} isEmpty={resultIsEmpty} isError={isError}
              writeAcknowledgment={isWriteToolName(block.toolName)}
              preview={readPreview} ansi={toolNameIs(block.toolName, "lsp")}
              language={!isError && !isStreamingInput ? toolOutputLanguage(block.toolName, block.input, readPreview?.text ?? resultText ?? "", result.details) : null} />
          </TaskResultOutput>
        )
      )}
      </>}
    </ToolCard>
  );
}

const TASK_STATUS_LABELS = {
  pending: "backgroundJobs.running",
  running: "backgroundJobs.running",
  completed: "backgroundJobs.completed",
  failed: "backgroundJobs.failed",
  cancelled: "backgroundJobs.cancelled",
  interrupted: "agentSwitcher.status.interrupted",
} as const;

function TaskResultOutput({ callId, tool, result, details = result?.details, slot, output = "", children }: {
  callId: string;
  tool: string;
  result?: ToolResultMessage;
  details?: unknown;
  slot?: number;
  output?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const cards = taskToolCards(tool, details, output, result, slot);
  if (cards.length === 0) return children;
  return (
    <div className="task-tool-output">
      <span className="shell-output-label">{t("session.output")}</span>
      <JobResultCards callId={callId} cards={cards} />
      {output.trim() && children && !(isRecord(details) && details.kind === "pi-web-subagent") && (
        <details className="task-tool-raw-output">
          <summary>{t("chat.rawToolOutput")}</summary>
          {children}
        </details>
      )}
    </div>
  );
}

function JobResultCards({ callId, cards, cwd, onOpenFile }: {
  callId: string;
  cards: readonly TaskResultCard[];
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
}) {
  const { t } = useI18n();
  return cards.map((card, index) => {
    const id = `${callId}:result:${card.id}:${index}`;
    const failed = card.status === "failed";
    const error = card.error && card.error !== card.output ? card.error : "";
    const tool = card.tool ?? "task";
    if (tool === "bash") {
      return <ConsoleOutputPreview key={id} callId={id} command={card.target} output={card.output}
        pending={card.status === "pending" || card.status === "running"} isError={failed}
        duration={card.durationMs} status={card.status === "cancelled" || card.status === "interrupted"
          ? t(TASK_STATUS_LABELS[card.status]) : undefined} />;
    }
    return (
      <ToolCard key={id} callId={id} toolName={tool} label={card.label} target={card.target}
        spark={card.status === "pending" || card.status === "running"}
        facts={t(TASK_STATUS_LABELS[card.status])} duration={card.durationMs} isError={failed}>
        {(expanded) => expanded && <div className="task-tool-result">
          {error && (error.length > MAX_MARKDOWN_CHARS ? <OversizedText>{error}</OversizedText> : <p className="task-tool-result-error">{error}</p>)}
          {tool !== "task" ? <ShellOutput output={card.output} isError={failed} showLabel={false} />
            : card.output ? <SafeMarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{card.output}</SafeMarkdownBody>
              : !error && <span className="shell-output-empty">{t("i18n.noOutput")}</span>}
        </div>}
      </ToolCard>
    );
  });
}

function useToolExpanded(callId: string, hasFailure: boolean): [boolean, (expanded: boolean) => void] {
  const preference = useExpansionPreference("tools");
  const [override, setOverride] = useState(() => isToolCallExpanded(callId));
  const expanded = override ?? toolCallExpandedByDefault(preference, hasFailure);
  return [expanded, (next) => {
    setToolCallExpanded(callId, next);
    setOverride(next);
  }];
}

function LiveToolElapsed({ timing, timeout }: { timing: NonNullable<ToolResultMessage["liveTiming"]>; timeout?: number | null }) {
  const { startedAt, endedAt } = timing;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (endedAt !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [startedAt, endedAt]);
  return formatToolTime(Math.max(0, (endedAt ?? now) - startedAt), timeout);
}

function formatToolTime(duration: number | undefined, timeout: number | null | undefined) {
  if (timeout === undefined) return duration === undefined ? null : formatToolDuration(duration);
  return `${duration === undefined ? "—" : (duration / 1000).toFixed(1)}/${timeout === null ? "-" : timeout === 0 ? "∞" : `${timeout}s`}`;
}

function ToolCard({ callId, toolName, label, mcpLabel, isError, hasFailure = isError, target, targetLanguage, facts, metadata, labelBadge, badge, timeout, duration, liveTiming, count = 0, action, children, spark, repeatSpark }: {
  callId: string;
  toolName: string;
  label?: string;
  mcpLabel?: McpToolLabel | null;
  isError: boolean;
  hasFailure?: boolean;
  target?: string;
  targetLanguage?: string;
  facts?: string;
  metadata?: ReactNode;
  labelBadge?: ReactNode;
  badge?: ReactNode;
  timeout?: number | null;
  duration?: number;
  liveTiming?: ToolResultMessage["liveTiming"];
  count?: number;
  action?: ReactNode;
  repeatSpark?: boolean;
  spark?: boolean;
  children: (expanded: boolean) => ReactNode;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useToolExpanded(callId, hasFailure);
  return (
    <div className="chat-tool-card" style={{
      borderRadius: 7,
      overflow: "hidden",
      fontSize: 12,
      border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
      background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
    }}>
      <CardSpark kind="input" active={spark} repeat={repeatSpark} />
      <div className="chat-tool-header" style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          style={{
            display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0,
            padding: "6px 10px", background: "none", border: "none",
            color: "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left",
          }}
        >
          <ToolBlockIcon toolName={toolName} mcpLabel={mcpLabel} isError={isError} />
          <span
            title={mcpLabel ? toolName : undefined}
            style={{ color: isError ? "#f87171" : TOOL_SUCCESS_LABEL_COLOR, fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, overflowWrap: "anywhere" }}
          >
            {mcpLabel ? <><span style={{ fontWeight: 500, opacity: 0.75 }}>{mcpLabel.server}/</span>{mcpLabel.tool}</> : label ?? toolName}
          </span>
          {labelBadge}
          <span title={target} style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {targetLanguage && target ? <ToolSyntax text={target} language={targetLanguage} inline /> : target}
          </span>
          {facts && <span className="inline-tool-facts" title={facts}>{facts}</span>}
          {metadata}
          {badge}
          {count > 0 && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
              {count === 1 ? t("codemode.callCountOne") : t("codemode.callCount", { count })}
            </span>
          )}
          {(duration !== undefined || liveTiming || timeout !== undefined) && (
            <span className="tool-card-time" title={timeout == null ? undefined : t(timeout === 0 ? "chat.eval.noTimeout" : "chat.eval.requestedTimeout")}>
              {duration === undefined && liveTiming ? <LiveToolElapsed timing={liveTiming} timeout={timeout} /> : formatToolTime(duration, timeout)}
            </span>
          )}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
        {action}
      </div>
      {children(expanded)}
    </div>
  );
}
type ToolIconKind = "read" | "write" | "glob" | "grep" | "edit" | "bash" | "todo" | "eval" | "task" | "browser" | "image"
  | "lsp" | "retain" | "recall" | "reflect" | "memory_edit" | "mcp" | "gitnexus-impact" | "changes" | "runtests" | "typecheck" | "gitshow" | "upstream" | "wait" | "ask" | "github" | "generic";

const TOOL_ICON_COLORS: Record<ToolIconKind, string> = {
  read: "var(--accent)",
  write: "var(--warning)",
  glob: "var(--accent-hover)",
  grep: "var(--accent)",
  edit: "var(--warning)",
  bash: "var(--success)",
  todo: "var(--warning)",
  eval: "var(--accent-hover)",
  task: "var(--accent)",
  browser: "var(--accent-hover)",
  image: "var(--success)",
  lsp: "var(--accent)",
  retain: "var(--warning)",
  recall: "var(--accent)",
  reflect: "var(--accent-hover)",
  memory_edit: "var(--warning)",
  mcp: "var(--accent-hover)",
  "gitnexus-impact": "var(--accent)",
  changes: "var(--warning)",
  runtests: "var(--success)",
  typecheck: "var(--accent)",
  gitshow: "var(--accent-hover)",
  upstream: "var(--accent-hover)",
  wait: "var(--warning)",
  ask: "var(--accent)",
  github: "var(--text-muted)",
  generic: "var(--text-dim)",
};

function toolNameHasPart(toolName: string, part: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === part ||
    normalized.endsWith(`.${part}`) ||
    normalized.endsWith(`_${part}`) ||
    normalized.split(/[.\s:_-]+/).includes(part);
}

function getToolIconKind(toolName: string, mcpLabel?: McpToolLabel | null): ToolIconKind {
  const normalized = toolName.trim().toLowerCase();
  if (normalized.startsWith("mcp__")) {
    const isImpact = mcpLabel
      ? mcpLabel.server === "gitnexus" && mcpLabel.tool === "impact"
      : normalized === "mcp__gitnexus_impact" || normalized === "mcp__gitnexus__impact";
    return isImpact ? "gitnexus-impact" : "mcp";
  }
  switch (normalized) {
    case "lsp":
    case "retain":
    case "recall":
    case "reflect":
    case "memory_edit":
    case "wait":
    case "ask":
    case "github":
      return normalized;
    // this project's own tools in .omp/tools; "impact" is the same blast-radius idea as GitNexus's
    case "impact":
      return "gitnexus-impact";
    case "changes":
    case "runtests":
    case "typecheck":
    case "gitshow":
    case "upstream":
      return normalized;
  }
  if (normalized.includes("str_replace") || normalized.includes("replace_editor") || toolNameHasPart(normalized, "edit")) return "edit";
  if (toolNameHasPart(normalized, "read") || toolNameHasPart(normalized, "cat")) return "read";
  if (toolNameHasPart(normalized, "write") || toolNameHasPart(normalized, "save")) return "write";
  if (toolNameHasPart(normalized, "glob") || toolNameHasPart(normalized, "find")) return "glob";
  if (toolNameHasPart(normalized, "grep") || toolNameHasPart(normalized, "search")) return "grep";
  if (toolNameHasPart(normalized, "bash") || toolNameHasPart(normalized, "shell") || toolNameHasPart(normalized, "exec")) return "bash";
  if (toolNameHasPart(normalized, "todo")) return "todo";
  if (toolNameHasPart(normalized, "eval")) return "eval";
  if (toolNameHasPart(normalized, "task") || toolNameHasPart(normalized, "agent")) return "task";
  if (toolNameHasPart(normalized, "browser") || toolNameHasPart(normalized, "web_search") || toolNameHasPart(normalized, "fetch")) return "browser";
  if (toolNameHasPart(normalized, "image") || toolNameHasPart(normalized, "inspect_image")) return "image";
  return "generic";
}

function ToolBlockIcon({ toolName, mcpLabel, isError }: {
  toolName: string;
  mcpLabel?: McpToolLabel | null;
  isError: boolean;
}) {
  const kind = getToolIconKind(toolName, mcpLabel);
  const color = isError ? "var(--danger)" : TOOL_ICON_COLORS[kind];
  // the glyph is an alpha mask over currentColor, so it follows the theme like inline strokes did
  const mask = `url(/tool-icons/${kind}.svg) center / contain no-repeat`;

  return (
    <span
      aria-hidden="true"
      data-tool-icon={kind}
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        flexShrink: 0,
        backgroundColor: "currentColor",
        mask,
        WebkitMask: mask,
        color,
      }}
    />
  );
}

type TodoPreviewStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

interface TodoPreviewTask {
  content: string;
  status: TodoPreviewStatus;
  blocker?: string;
}

interface TodoPreviewPhase {
  name: string;
  tasks: TodoPreviewTask[];
}

function getTodoPreviewPhases(block: ToolCallContent, result?: ToolResultMessage): TodoPreviewPhase[] | null {
  const details = result?.details;
  if (isRecord(details) && Array.isArray(details.phases)) {
    const phases = details.phases.flatMap((phase): TodoPreviewPhase[] => {
      if (!isRecord(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return [];
      const tasks = phase.tasks.flatMap((task): TodoPreviewTask[] => {
        if (!isRecord(task) || typeof task.content !== "string" || !isTodoPreviewStatus(task.status)) return [];
        return [{ content: task.content, status: task.status, blocker: typeof task.blocker === "string" ? task.blocker : undefined }];
      });
      return tasks.length > 0 ? [{ name: phase.name, tasks }] : [];
    });
    if (phases.length > 0) return phases;
  }

  const input = block.input;
  if (!isRecord(input) || !Array.isArray(input.list)) return null;
  const phases = input.list.flatMap((phase): TodoPreviewPhase[] => {
    if (!isRecord(phase) || typeof phase.phase !== "string" || !Array.isArray(phase.items)) return [];
    const tasks = phase.items
      .filter((item): item is string => typeof item === "string")
      .map((content) => ({ content, status: "pending" as const }));
    return tasks.length > 0 ? [{ name: phase.phase, tasks }] : [];
  });
  return phases.length > 0 ? phases : null;
}

function isTodoPreviewStatus(value: unknown): value is TodoPreviewStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned" || value === "blocked";
}

function TodoChecklistPreview({ phases }: { phases: TodoPreviewPhase[] }) {
  const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  const completedTasks = phases.reduce(
    (sum, phase) => sum + phase.tasks.filter((task) => task.status === "completed").length,
    0,
  );

  return (
    <div className="todo-checklist-preview" role="list" aria-label={`Todo ${totalTasks} tasks`}>
      <div className="todo-checklist-header">
        <svg className="todo-checklist-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M5.5 3.25h7M5.5 7h7M5.5 10.75h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="m1.5 3.1 1 1 1.7-1.9M1.5 6.85l1 1 1.7-1.9M1.5 10.6l1 1 1.7-1.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="todo-checklist-title">Todo</span>
        <span className="todo-checklist-count">{totalTasks} {totalTasks === 1 ? "task" : "tasks"}</span>
        {completedTasks > 0 && completedTasks < totalTasks && (
          <span className="todo-checklist-progress">{completedTasks}/{totalTasks}</span>
        )}
      </div>
      <div className="todo-checklist-body">
        {phases.map((phase, phaseIndex) => (
          <div key={`${phase.name}-${phaseIndex}`} className="todo-checklist-phase">
            {phases.length > 1 && <div className="todo-checklist-phase-name">{phase.name}</div>}
            {phase.tasks.map((task, taskIndex) => (
              <TodoChecklistRow key={`${task.content}-${taskIndex}`} task={task} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function TodoChecklistRow({ task }: { task: TodoPreviewTask }) {
  const completed = task.status === "completed";
  const abandoned = task.status === "abandoned";
  const active = task.status === "in_progress";
  const blocked = task.status === "blocked";
  const marker = completed ? "✓" : abandoned ? "×" : blocked ? "!" : active ? "›" : "";
  const statusClass = completed
    ? "is-completed"
    : abandoned
    ? "is-abandoned"
    : blocked
    ? "is-blocked"
    : active
    ? "is-active"
    : "is-pending";

  return (
    <div
      role="listitem"
      aria-label={`${task.status}: ${task.content}`}
      className={`todo-checklist-row ${statusClass}`}
    >
      <span aria-hidden="true" className="todo-checklist-marker">
        {marker}
      </span>
      <span className="todo-checklist-content">
        {task.content}
        {blocked && task.blocker ? <span className="todo-checklist-blocker"> ({task.blocker})</span> : null}
      </span>
    </div>
  );
}

function ConsoleOutputPreview({
  callId,
  command,
  output,
  pending,
  isError,
  duration,
  local,
  status,
  spark,
  liveTiming,
}: {
  callId: string;
  command: string;
  output: string;
  pending: boolean;
  spark?: boolean;
  isError: boolean;
  duration?: number;
  liveTiming?: ToolResultMessage["liveTiming"];
  local?: boolean;
  status?: string;
}) {
  const [expanded, setExpanded] = useToolExpanded(callId, isError);

  return (
    <div className={`shell-output-preview${isError ? " is-error" : ""}`}>
      <CardSpark kind="input" active={spark ?? pending} />
      <button type="button" className="shell-command-line chat-tool-header" aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        style={{ width: "100%", border: 0, background: "none", textAlign: "left", cursor: "pointer" }}>
        <span className="shell-command-prompt" aria-hidden="true">$</span>
        <span className="shell-command-code" style={{
          flex: 1, minWidth: 0, color: "var(--text)", fontFamily: "var(--font-mono)",
          fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
        }}>
          <ToolSyntax text={command || " "} language="bash" />
        </span>
        {local && <span className="shell-local-label">local</span>}
      </button>

      {expanded && <ShellOutput output={output} pending={pending} isError={isError} />}

      {(status || duration !== undefined || liveTiming) && (
        <div className="shell-output-footer">
          {status}{status && (duration !== undefined || liveTiming) ? " · " : ""}
          {duration === undefined && liveTiming ? <LiveToolElapsed timing={liveTiming} /> : formatToolTime(duration, undefined)}
        </div>
      )}
    </div>
  );
}

function ShellOutput({ output, pending = false, isError, showLabel = true, language }: {
  output: string;
  pending?: boolean;
  isError: boolean;
  showLabel?: boolean;
  language?: string | null;
}) {
  const { t } = useI18n();
  if (output.length > MAX_MARKDOWN_CHARS) return <OversizedText>{output}</OversizedText>;
  const syntax = pending || isError || output.includes("\x1b") ? null : language ?? jsonLanguage(output);
  const outputLines = syntax || !output ? [] : normalizeCustomPanelLines(output.split(/\r?\n/));
  const statusLabel = pending ? t("chat.runningCommand") : isError ? "failed" : "";
  return (
    <div className="shell-output-panel">
      {(showLabel || statusLabel) && <div className="shell-output-divider">
        {showLabel && <span className="shell-output-label">{t("session.output")}</span>}
        {statusLabel && <span className={`shell-output-status${isError ? " is-error" : pending ? " is-pending" : ""}`}>{statusLabel}</span>}
      </div>}
      <div className="shell-output-body" aria-live={pending ? "polite" : undefined}>
        {!output && !pending && (
          <span className="shell-output-empty">{t("i18n.noOutput")}</span>
        )}
        {syntax ? (
          <pre className="shell-output-line" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><ToolSyntax text={output} language={syntax} /></pre>
        ) : outputLines.map((line, lineIndex) => {
          const plainLine = stripAnsi(line).trimStart();
          const lineClass = isError || /^(?:error|fatal|failed|failure|✖|x\b)/i.test(plainLine)
            ? "is-error"
            : /^(?:warning|warn|!)/i.test(plainLine)
            ? "is-warning"
            : /^(?:success|passed|ok\b|✓|\+)/i.test(plainLine)
            ? "is-success"
            : "";
          return (
            <div key={lineIndex} className={`shell-output-line ${lineClass}`.trim()}>
              {parseAnsiLine(line).map((segment, segmentIndex) => (
                Object.keys(segment.style).length > 0
                  ? <span key={segmentIndex} style={segment.style}>{segment.text}</span>
                  : <span key={segmentIndex}>{segment.text}</span>
              ))}
              {line === "" ? "\u00a0" : null}
            </div>
          );
        })}
        {pending && (
          <span className="shell-output-pending" aria-label={t("chat.runningCommand")}>▋</span>
        )}
      </div>
    </div>
  );
}

function MountedToolCards({ callId, dispatches, result, command, output, isError, hasFinalTiming, duration, liveTiming, cwd, spark }: {
  callId: string;
  dispatches: readonly ToolDispatch[];
  result?: ToolResultMessage;
  command: string;
  output: string;
  isError: boolean;
  hasFinalTiming: boolean;
  duration?: number;
  liveTiming?: ToolResultMessage["liveTiming"];
  cwd?: string;
  spark?: boolean;
}) {
  const { t } = useI18n();
  const readPreviews = useToolDisplayPreference("readPreviews");
  const single = dispatches.length === 1;
  return (
    <div className="shell-tool-commands">
      {dispatches.map(({ tool, mode, args, inner, exitCode }, index) => {
        const dispatchId = `${callId}:cmd:${index}`;
        const failed = (hasFinalTiming || isError) && exitCode !== 0;
        const inputView = mode === "execute" && args ? describeToolInput(tool, args, t) : null;
        const read = mode === "execute" && toolNameIs(tool, "read");
        // A single mounted read can still have its stdout piped into another process.
        // Only use its display body when the shell line is plainly a standalone read.
        const shellLine = command.trim();
        const simpleRead = read && single && /^read(?:[ \t]|$)/.test(shellLine) && !/[|&;<>()$`\r\n]/.test(shellLine);
        const preview = simpleRead && !isError && !failed && output.length <= MAX_MARKDOWN_CHARS && !output.includes("\x1b")
          ? readToolPreview(output, args?.path ?? args?.file_path, inner, readPreviews) : null;
        const target = mode === "help" ? t("chat.toolHelp")
          : read && args ? preview?.url ?? readHeaderTarget(args)
          : inputView?.target ?? inlineToolTarget(tool, args);
        const visibleArgs = inputView && read ? omitShownReadPath(inputView.args, target) : inputView?.args;
        const isWrite = isWriteToolName(tool);
        const isLsp = toolNameIs(tool, "lsp");
        const facts = [
          mode === "execute" ? inlineToolResult(tool, inner, t) : "",
          failed ? t("terminal.exitCode", { code: exitCode }) : "",
        ].filter(Boolean).join(" · ");
        return (
          <ToolCard
            key={dispatchId}
            callId={dispatchId}
            toolName={tool}
            spark={spark}
            mcpLabel={mcpToolLabel(tool, inner)}
            target={target}
            targetLanguage={inputView?.targetLanguage}
            metadata={readPreviews && preview && <ReadHeaderMetadata preview={preview} target={target} />}
            labelBadge={inputView?.labelBadge}
            badge={inputView?.badge}
            timeout={inputView?.timeout}
            facts={facts}
            isError={failed || (single && isError)}
            hasFailure={failed || (single && isError) || taskToolCards(tool, inner, "", result, index).some((card) => card.status === "failed")}
            duration={single ? duration : undefined}
            liveTiming={single ? liveTiming : undefined}
          >
            {(expanded) => expanded && <>
              {args && visibleArgs && Object.keys(visibleArgs).length > 0 && <ShellToolArguments tool={tool} args={visibleArgs} sourceArgs={args} />}
              {args && inputView?.fileContent !== undefined && <WrittenToolCode text={inputView.fileContent} args={args} />}
              {inputView?.evalCode && <EvalToolCode {...inputView.evalCode} cwd={cwd} />}
              {mode === "execute" ? (
                <TaskResultOutput callId={dispatchId} tool={tool} details={inner} result={result} slot={index} output={single ? output : ""}>
                  {single && ((preview || isWrite || isLsp) ? (
                    <PairedResult text={output} isEmpty={!output.trim()} isError={isError || failed}
                      language={toolOutputLanguage(tool, args ?? {}, preview?.text ?? output, inner)}
                      preview={preview} writeAcknowledgment={isWrite} ansi={isLsp} />
                  ) : <ShellOutput output={output} isError={isError || failed} language={toolOutputLanguage(tool, args ?? {}, output, inner)} />)}
                </TaskResultOutput>
              ) : single && <ShellOutput output={output} isError={isError} />}
            </>}
          </ToolCard>
        );
      })}
      {!single && (
        <ToolCard callId={callId} toolName="bash" label={t("session.output")} isError={isError} duration={duration}>
          {(expanded) => expanded && <ShellOutput output={output} isError={isError} showLabel={false} />}
        </ToolCard>
      )}
    </div>
  );
}

function ShellToolArguments({ tool, args, sourceArgs }: { tool: string; args: Record<string, unknown>; sourceArgs: Record<string, unknown> }) {
  const compactJson = useToolDisplayPreference("compactJson");
  const fields = toolFieldsOfInput(args);
  return <div className="shell-tool-arguments">
    {fields ? <ToolFieldRows fields={fields} tool={tool} args={sourceArgs} /> : (
      <pre><ToolSyntax text={compactJson ? compactStringify(args) : JSON.stringify(args, null, 2)} language="json" /></pre>
    )}
  </div>;
}


function getStructuredToolPreview(block: ToolCallContent, phases: TodoPreviewPhase[] | null): string {
  if (phases) {
    const tasks = phases.flatMap((phase) => phase.tasks);
    const completed = tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;
    return `${completed}/${tasks.length} tasks`;
  }
  return getToolPreview(block);
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff, targetPath, streaming }: {
  diff: ResultDiff;
  targetPath?: string;
  streaming?: boolean;
}) {
  if (diff.text.length > MAX_MARKDOWN_CHARS) return <OversizedText>{diff.text}</OversizedText>;
  return (
    <div
      style={{
        borderTop: "1px solid rgba(34,197,94,0.15)",
        background: "var(--bg)",
      }}
    >
      <SplitPatchView text={diff.text} targetPath={targetPath} streaming={streaming} />
    </div>
  );
}

function SplitPatchView({ text, targetPath, streaming }: { text: string; targetPath?: string; streaming?: boolean }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  return <SplitFilesView files={files} targetPath={targetPath} streaming={streaming} />;
}

/** Two code columns side by side, or one column of patch lines. */
export type PatchDiffLayout = "split" | "stacked";

/**
 * The patch as the viewport can show it. Two columns need two code columns side
 * by side, which a phone does not have: there the same rows read as one column
 * — a removed line above the line that replaces it, each with its own number.
 */
function SplitFilesView({ files, targetPath, streaming }: { files: SplitDiffFile[]; targetPath?: string; streaming?: boolean }) {
  const layout: PatchDiffLayout = useIsMobile() ? "stacked" : "split";
  return <PatchDiffFiles files={files} layout={layout} targetPath={targetPath} streaming={streaming} />;
}

export function PatchDiffFiles({ files, layout, targetPath, streaming = false }: { files: SplitDiffFile[]; layout: PatchDiffLayout; targetPath?: string; streaming?: boolean }) {
  const { t } = useI18n();
  const showFileHeaders = files.length > 1;
  const languages = useMemo(() => files.map((file) => fileLanguage(stackedFilePath(file) || targetPath || "")), [files, targetPath]);
  const eligible = canHighlightDiff(files, streaming) && languages.some((language) => language !== "text" && language !== "pdf" && language !== "word");
  const ready = usePrismLanguages(eligible);
  const tokens = useMemo(() => eligible && ready
    ? files.map((file, index) => highlightDiffFile(file, languages[index]))
    : [], [eligible, ready, files, languages]);

  return (
    <div style={{ background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          className={`omp-syntax${languages[fileIndex] === "json" ? " language-json" : ""}`}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontWeight: "var(--font-mono-weight)",
            fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && layout === "split" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
               <SplitDiffHeader title={file.oldPath || t("i18n.before")} side="left" />
               <SplitDiffHeader title={file.newPath || t("i18n.after")} side="right" />
            </div>
          )}

          {showFileHeaders && layout === "stacked" && stackedFilePath(file) && (
            <div
              title={stackedFilePath(file)}
              style={{
                position: "sticky",
                top: 0,
                zIndex: 1,
                padding: "5px 10px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {stackedFilePath(file)}
            </div>
          )}

          {layout === "split" && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null;
              }
              if (row.type === "gap") {
                return <DiffGapRow key={rowIndex} gap={row} />;
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={row.left} side="left" tokens={tokens[fileIndex]?.get(row.left)} />
                  <SplitDiffCellView cell={row.right} side="right" tokens={tokens[fileIndex]?.get(row.right)} />
                </div>
              );
            })}
          </div>
          )}

          {layout === "stacked" && file.rows.map((row, rowIndex) => {
            if (row.type === "hunk") return null;
            if (row.type === "gap") return <DiffGapRow key={rowIndex} gap={row} />;
            if (row.left.type === "context" && row.right.type === "context") {
              return <SplitDiffCellView key={rowIndex} cell={row.right} side="right" tokens={tokens[fileIndex]?.get(row.right)} />;
            }
            return <div key={rowIndex}>
              {row.left.type !== "empty" && <SplitDiffCellView cell={row.left} side="right" tokens={tokens[fileIndex]?.get(row.left)} />}
              {row.right.type !== "empty" && <SplitDiffCellView cell={row.right} side="right" tokens={tokens[fileIndex]?.get(row.right)} />}
            </div>;
          })}
        </div>
      ))}
    </div>
  );
}

/** Unchanged lines the patch leaves out between two hunks, across the whole width. */
function DiffGapRow({ gap }: { gap: SplitDiffGap }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        gridColumn: "1 / -1",
        padding: "0 10px",
        color: "var(--text-dim)",
        background: "var(--bg-panel)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        userSelect: "none",
      }}
    >
      {gap.count === null ? "⋯" : `⋯ ${diffGapLabel(gap.count, t)}`}
    </div>
  );
}

/** The file a stacked section is named for: the new path, the one that survives, unless the file was deleted. */
function stackedFilePath(file: SplitDiffFile): string {
  if (file.newPath && file.newPath !== "/dev/null") return file.newPath;
  return file.oldPath || file.newPath || "";
}


function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side, tokens }: { cell: SplitDiffCell; side: "left" | "right"; tokens?: DiffToken[] }) {
  const bg =
    cell.type === "added"
      ? "rgba(34,197,94,0.12)"
      : cell.type === "removed"
      ? "rgba(248,113,113,0.13)"
      : cell.type === "empty"
      ? "var(--bg-subtle)"
      : "transparent";
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  const markerColor =
    cell.type === "added" ? "#22c55e" : cell.type === "removed" ? "#f87171" : "var(--text-dim)";

  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {tokens && cell.text ? tokens.map((token, index) => token.className ? <span key={index} className={token.className}>{token.text}</span> : token.text) : cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div style={{ maxHeight: 520, overflowY: "auto", overflowX: "hidden", fontFamily: "var(--font-mono)", fontWeight: "var(--font-mono-weight)", fontSize: "calc(12px + var(--chat-font-size-offset, 0px))", lineHeight: 1.55, minWidth: 0 }}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith("@@") ? "hunk" :
          line.startsWith("+") && !line.startsWith("+++") ? "added" :
          line.startsWith("-") && !line.startsWith("---") ? "removed" :
          "context";
        const bg =
          kind === "added" ? "rgba(34,197,94,0.12)" :
          kind === "removed" ? "rgba(248,113,113,0.13)" :
          kind === "hunk" ? "rgba(96,165,250,0.12)" :
          "transparent";
        const color =
          kind === "added" ? "#22c55e" :
          kind === "removed" ? "#f87171" :
          kind === "hunk" ? "var(--accent)" :
          "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft: kind === "added"
                ? "3px solid #22c55e"
                : kind === "removed"
                ? "3px solid #f87171"
                : kind === "hunk"
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Split diff rows for an apply_patch-style tool call.
 *
 * Prefers parsing the V4A patch document from the call input. The extension's
 * applied result preview contains the complete old/new file with unchanged
 * lines, so it is only used as a fallback when the call input is unavailable.
 * A single call may contain several file operations — each becomes its own
 * file section.
 */
function getApplyPatchFiles(block: ToolCallContent, result?: ToolResultMessage): SplitDiffFile[] | null {
  if (!isApplyPatchToolName(block.toolName)) return null;

  const fromInput = parseApplyPatchInput(getApplyPatchInputText(block.input, block.rawInput));
  if (fromInput) return fromInput;

  const details = result && !result.isError ? (result as ToolResultMessage & { details?: unknown }).details : undefined;
  if (isRecord(details)) {
    const fromPreview = applyPatchPreviewToFiles(details.preview);
    if (fromPreview) return fromPreview;
  }

  return null;
}

/** Header label listing the files targeted by an apply_patch call. */
function summarizeApplyPatchInput(block: ToolCallContent): string | null {
  const paths = extractApplyPatchPaths(getApplyPatchInputText(block.input, block.rawInput));
  if (paths.length === 0) return null;
  return paths.join(", ").slice(0, 120);
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ResultImages({ images, isError }: { images: ImageContent[]; isError: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        padding: "10px",
        background: "var(--bg)",
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
      }}
    >
      {images.map((image, index) => {
        const src = imageSource(image);
        if (!src) return null;
        return (
          <ImagePreview
            key={`${src}-${index}`}
            src={src}
            style={{ maxWidth: "100%" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              loading="lazy"
              style={{
                display: "block",
                maxWidth: "min(100%, 720px)",
                maxHeight: 520,
                borderRadius: 6,
                objectFit: "contain",
                border: "1px solid var(--border)",
              }}
            />
          </ImagePreview>
        );
      })}
    </div>
  );
}

function ToolDocument({ text, compact = false, controls }: { text: string; compact?: boolean; controls?: ReactNode }) {
  return text.length > MAX_MARKDOWN_CHARS ? <OversizedText>{text}</OversizedText> : (
    <div className={compact ? "markdown-body tool-read-document" : "markdown-body"} style={{ padding: "8px 10px", maxHeight: 400, overflow: "auto" }}>
      {controls}
      <ReactMarkdown skipHtml disallowedElements={["img"]} remarkPlugins={markdownRemarkPlugins}>{text}</ReactMarkdown>
    </div>
  );
}

const TOOL_SUCCESS_LABEL_COLOR = "#16a34a";

function RawToolToggle({ raw, toggle }: { raw: boolean; toggle: () => void }) {
  const { t } = useI18n();
  return <button type="button" className="tool-raw-toggle" onClick={toggle}>
    {t(raw ? "chat.toolShowPreview" : "chat.toolShowRaw")}
  </button>;
}

function PairedResult({ text, isEmpty, isError, language, preview, writeAcknowledgment, ansi }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
  language?: string | null;
  preview?: ReadToolPreview | null;
  writeAcknowledgment?: boolean;
  ansi?: boolean;
}) {
  const { t } = useI18n();
  const [raw, setRaw] = useState(false);
  const visibleText = !raw && preview ? preview.text : text;
  const written = writeAcknowledgment && !isError
    ? /^(?:\[[^\r\n]+#[\dA-F]{4}\]\r?\n)?(Successfully wrote \d+ bytes to [^\r\n]+)([\s\S]*)$/i.exec(visibleText)
    : null;
  if (text.length > MAX_MARKDOWN_CHARS) return <OversizedText>{text}</OversizedText>;
  const controls = preview && <RawToolToggle raw={raw} toggle={() => setRaw(!raw)} />;
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      {!raw && preview?.markdown ? <ToolDocument text={visibleText} compact controls={controls} /> : (
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {controls}
        {isEmpty ? t("i18n.noOutput") : written ? <>
          <span style={{ color: TOOL_SUCCESS_LABEL_COLOR }}>{written[1]}</span>{written[2]}
        </> : ansi && visibleText.includes("\x1b") ? parseAnsiLine(visibleText).map(({ text, style }, index) => (
          <span key={index} style={style}>{text}</span>
        )) : <ToolSyntax text={visibleText} language={isError ? null : language} />}
      </pre>
      )}
    </div>
  );
}

function CompactionMessageView({ message, showFlow }: { message: CustomMessage; showFlow: boolean }) {
  const { t } = useI18n();
  const [expanded, toggleExpanded] = useBlockExpansion("compaction");
  const summary = getMessageText(message.content);
  const time = formatTime(message.timestamp);
  const tokensBefore = (message.details as { tokensBefore?: unknown } | undefined)?.tokensBefore;

  return (
    <div className="transcript-message">
      {showFlow && <TokenFlowHandoff kind="compaction" label={t("i18n.conversationCompacted")} time={time} />}
      <TranscriptBlock
        data-transcript-port="input"
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            compaction
          </span>
          {!showFlow && time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <button
            type="button"
            aria-expanded={expanded}
            title={expanded ? t("i18n.collapse") : t("i18n.expand")}
            onClick={toggleExpanded}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              width: "100%",
              padding: 0,
              border: "none",
              background: "transparent",
              color: "var(--text)",
              cursor: "pointer",
              font: "inherit",
              textAlign: "left",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: 4, color: "var(--text-muted)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
              <polyline points="4 2.5 7.5 6 4 9.5" />
            </svg>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: "calc(15px + var(--chat-font-size-offset, 0px))", fontWeight: 700, lineHeight: 1.35 }}>
                {t("i18n.conversationCompacted")}
              </span>
              {typeof tokensBefore === "number" && Number.isFinite(tokensBefore) && (
                <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: "calc(13px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
                  {t("i18n.compactedFromTokens", { tokens: tokensBefore.toLocaleString() })}
                </span>
              )}
            </span>
          </button>
          {expanded && <CompactionSummaryDetails summary={summary} />}
        </div>
      </TranscriptBlock>
    </div>
  );
}

export function CompactionSummaryDetails({ summary }: { summary: string }) {
  const { t } = useI18n();
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ marginBottom: 10, color: "var(--text)", fontSize: "calc(14px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
         {t("i18n.compactionDescription")}
      </div>
      {parsedSummary.body ? (
        <SafeMarkdownBody className="markdown-compaction-message">{parsedSummary.body}</SafeMarkdownBody>
      ) : (
         <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noSummary")}</span>
      )}
      <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
    </div>
  );
}

function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} read`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);

  return (
    <details className="compaction-file-details">
       <summary>{t("i18n.fileContext", { details: parts.join(", ") })}</summary>
       {modifiedFiles.length > 0 && <CompactionFileList title={t("i18n.modifiedFiles")} files={modifiedFiles} />}
       {readFiles.length > 0 && <CompactionFileList title={t("i18n.readFiles")} files={readFiles} />}
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

function CustomMessageView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void }) {
  const { t } = useI18n();
  // Expanded by default: pi's TUI always draws a displayed custom message in full.
  const [contentExpanded, setContentExpanded] = useState(true);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const jobCards = asyncResultCards(message);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = jobCards.length ? t("backgroundJobs.results") : formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="transcript-message">
      <TranscriptBlock
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: contentExpanded ? "1px solid var(--border)" : "none",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <button
            type="button"
            onClick={() => setContentExpanded((v) => !v)}
            aria-expanded={contentExpanded}
            title={contentExpanded ? t("i18n.collapse") : t("i18n.expand")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
              flex: 1,
              padding: 0,
              border: "none",
              background: "none",
              color: "inherit",
              cursor: "pointer",
              fontSize: "inherit",
              textAlign: "left",
            }}
          >
            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650, flexShrink: 0 }}>
              {title}
            </span>
            {!contentExpanded && text && jobCards.length === 0 && (
              <span style={{ color: "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {text.slice(0, 300).replace(/\s+/g, " ").trim()}
              </span>
            )}
            {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{time}</span>}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: contentExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        {contentExpanded && (
          <>
            <div style={{ padding: "6px 9px" }}>
              {images.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                  {images.map((img, i) => {
                    const src = imageSource(img);
                    if (!src) return null;
                    return (
                      <ImagePreview key={i} src={src}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={src}
                          alt=""
                          style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                        />
                      </ImagePreview>
                    );
                  })}
                </div>
              )}
              {jobCards.length > 0 ? (
                <div className="async-result-cards">
                  <JobResultCards callId={`async:${message.timestamp ?? ""}`} cards={jobCards} cwd={cwd} onOpenFile={onOpenFile} />
                </div>
              ) : text ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noMessage")}</span>}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 9px",
                borderTop: "1px solid var(--border)",
                background: "var(--bg-subtle)",
              }}
            >
              {text || detailsText ? (
                <button
                  onClick={copyContent}
                  style={{
                    padding: "3px 7px",
                    border: "none",
                    background: "none",
                    color: copied ? "var(--accent)" : "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                   {copied ? t("i18n.copied") : t("i18n.copy")}
                </button>
              ) : null}
              {hasDetails && (
                <button
                  onClick={() => setDetailsExpanded((v) => !v)}
                  style={{
                    marginLeft: "auto",
                    padding: "3px 7px",
                    border: "none",
                    background: "none",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  {detailsExpanded ? t("i18n.hideDetails") : t("i18n.showDetails")}
                </button>
              )}
            </div>

            {hasDetails && detailsExpanded && (
              <pre
                style={{
                  margin: 0,
                  padding: "9px 10px",
                  borderTop: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text-muted)",
                  fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 360,
                  overflow: "auto",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {detailsText}
              </pre>
            )}
          </>
        )}
      </TranscriptBlock>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getToolCallInputText(block: ToolCallContent, compact = false, args = block.input): string {
  return block.rawInput ?? (compact ? compactStringify(args) : JSON.stringify(args, null, 2));
}

interface ToolInputView {
  args: Record<string, unknown>;
  target?: string;
  targetLanguage?: string;
  fileContent?: string;
  evalCode?: { text: string; language: "js" | "py" };
  labelBadge?: ReactNode;
  badge?: ReactNode;
  timeout?: number | null;
}

function ToolHeaderBadge({ children, title, icon = false, state }: { children: ReactNode; title: string; icon?: boolean; state?: "on" | "off" }) {
  return <span className="tool-card-badge" data-state={state} title={title} role={icon ? "img" : undefined} aria-label={icon ? title : undefined}>{children}</span>;
}

function ReadHeaderMetadata({ preview, target }: { preview: ReadToolPreview; target?: string }) {
  const { contentType, method, notes, hash, sourcePath } = preview;
  const MethodIcon = method?.startsWith("github-") ? Github : method === "firecrawl" ? Firecrawl : method === "jina" ? Jina : null;
  const metadata = [contentType, notes, sourcePath !== target && sourcePath, hash && `#${hash}`].filter(Boolean).join(" · ");
  return <>
    {metadata && <span className="inline-tool-facts" title={metadata}>{metadata}</span>}
    {method && <ToolHeaderBadge title={method} icon={!!MethodIcon}>{MethodIcon ? <MethodIcon size={13} /> : method}</ToolHeaderBadge>}
  </>;
}

function readHeaderTarget(args: Record<string, unknown>): string {
  if (typeof args.i === "string" && args.i.trim()) return args.i.trim();
  if (typeof args.path === "string") return args.path;
  return typeof args.file_path === "string" ? args.file_path : "";
}

function omitShownReadPath(args: Record<string, unknown>, target: string): Record<string, unknown> {
  const key = typeof args.path === "string" ? "path" : "file_path";
  if (args[key] !== target) return args;
  return Object.fromEntries(Object.entries(args).filter(([field]) => field !== key));
}

type ToolFlag = "case" | "gitignore" | "hidden" | "reset" | "isolated" | "headed" | "persist";
type ToolFlagState = "on" | "off" | "invalid";

function toolFlagState(value: unknown, defaultValue?: boolean): ToolFlagState | undefined {
  if (value === null) return "invalid";
  const resolved = value === undefined ? defaultValue : value;
  if (typeof resolved === "boolean") return resolved ? "on" : "off";
}

function ToolFlagIcon({ kind, state }: { kind: ToolFlag | "skip"; state?: ToolFlagState }) {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "case" ? <path d="M1 11l3-7 3 7M2 9h4m8 2V7m0 2a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
      : kind === "gitignore" ? <><path d="M4 3v10m0-4h4a4 4 0 0 0 4-4" /><circle cx="4" cy="3" r="1.5" fill="var(--bg-subtle)" /><circle cx="4" cy="13" r="1.5" fill="var(--bg-subtle)" /><circle cx="12" cy="4" r="1.5" fill="var(--bg-subtle)" /></>
      : kind === "hidden" ? <><path d="M1 8s2.5-4 7-4 7 4 7 4-2.5 4-7 4-7-4-7-4Z" /><circle cx="8" cy="8" r="1.5" /></>
      : kind === "reset" ? <path d="M2 2v4h4M2.3 6a6 6 0 1 1 .3 5" />
      : kind === "isolated" ? <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><rect x="5.5" y="5.5" width="5" height="5" rx="1" /></>
      : kind === "headed" ? <><rect x="2" y="2.5" width="12" height="8.5" rx="1" /><path d="M8 11v3m-3 0h6" /></>
      : kind === "persist" ? <path d="M5.5 2h5M6 2v5L4 9v1h8V9l-2-2V2m-2 8v4" />
      : <path d="m2 4 4 4-4 4m6-8 4 4-4 4m6-8v8" />}
    {state === "off" && <><path d="m1 15 14-14" stroke="var(--bg-subtle)" strokeWidth="3" /><path d="m1 15 14-14" /></>}
    {state === "invalid" && <path d="M14 1v4m0 2v.1" />}
  </svg>;
}

function describeToolInput(tool: string, args: Record<string, unknown>, t: (key: string, params?: TranslationParams) => string): ToolInputView {
  const view: ToolInputView = { args };
  const kind = isWriteToolName(tool) ? "write" : (["grep", "glob", "eval", "task", "browser", "recall", "lsp"] as const).find((name) => toolNameIs(tool, name));
  if (!kind) return view;

  const displayed = new Set<string>();
  function headerText(key: string): string | undefined {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) return;
    displayed.add(key);
    return value;
  }
  function flagBadge(key: ToolFlag, defaultValue?: boolean) {
    const state = toolFlagState(args[key], defaultValue);
    if (state === undefined) return null;
    displayed.add(key);
    const title = state === "invalid" ? `${key}: ${t("chat.toolFlag.booleanOnly")}` : t(`chat.toolFlag.${key}.${state}`);
    return <ToolHeaderBadge title={title} icon state={state === "invalid" ? undefined : state}><ToolFlagIcon kind={key} state={state} /></ToolHeaderBadge>;
  }

  if (kind === "grep") {
    view.target = headerText("pattern");
    view.targetLanguage = "regex";
    const caseBadge = flagBadge("case", true);
    const gitignoreBadge = flagBadge("gitignore", true);
    const skip = args.skip;
    const validSkip = skip == null || (typeof skip === "number" && Number.isFinite(skip) && skip >= 0);
    if (validSkip) displayed.add("skip");
    const count = validSkip ? Math.floor(skip ?? 0) : 0;
    view.badge = <span className="tool-card-badges">
      {caseBadge}
      {gitignoreBadge}
      {validSkip && <ToolHeaderBadge
        title={count > 0 ? t("chat.grep.skipFiles", { count }) : t("chat.grep.firstPage")}
        icon state={skip === null ? undefined : count > 0 ? "on" : "off"}
      ><ToolFlagIcon kind="skip" />{count}</ToolHeaderBadge>}
    </span>;
  } else if (kind === "glob") {
    view.target = [headerText("i"), headerText("path"), headerText("pattern")].filter(Boolean).join(" · ");
    const hiddenBadge = flagBadge("hidden", true);
    const gitignoreBadge = flagBadge("gitignore", true);
    const limit = args.limit === undefined ? 200 : args.limit;
    const validLimit = typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 200;
    if (validLimit) displayed.add("limit");
    view.badge = <span className="tool-card-badges">
      {hiddenBadge}
      {gitignoreBadge}
      {validLimit && <ToolHeaderBadge title={t("chat.glob.limit", { count: limit })}>≤ {limit}</ToolHeaderBadge>}
    </span>;
  } else if (kind === "eval") {
    view.target = headerText("title") ?? "";
    const { code, language, timeout } = args;
    if (language === "js" || language === "py") {
      displayed.add("language");
      view.labelBadge = <ToolHeaderBadge title={language === "js" ? "JavaScript" : "Python"} icon>{getFileIcon(`.${language}`, 14)}</ToolHeaderBadge>;
      if (typeof code === "string" && code !== "") {
        displayed.add("code");
        view.evalCode = { text: code, language };
      }
    }
    view.badge = flagBadge("reset", false);
    if (timeout === null || (typeof timeout === "number" && Number.isFinite(timeout))) {
      displayed.add("timeout");
      view.timeout = timeout;
    }
  } else if (kind === "task") {
    if (Array.isArray(args.tasks) && args.tasks.length > 0) {
      const counts: Record<ToolFlagState, number> = { on: 0, off: 0, invalid: 0 };
      for (const item of args.tasks) {
        if (!isRecord(item)) continue;
        const state = toolFlagState(item.isolated === undefined ? args.isolated : item.isolated, false);
        if (state) counts[state]++;
      }
      view.badge = <span className="tool-card-badges">
        {(["on", "off", "invalid"] as const).map((state) => counts[state] > 0 && (
          <ToolHeaderBadge key={state} title={t(`chat.toolFlag.isolatedBatch.${state}`, { count: counts[state] })}
            icon state={state === "invalid" ? undefined : state}>
            <ToolFlagIcon kind="isolated" state={state} />{counts[state]}
          </ToolHeaderBadge>
        ))}
      </span>;
    } else {
      view.badge = flagBadge("isolated", false);
    }
  } else if (kind === "browser") {
    if (args.action === "open") {
      const headed = flagBadge("headed");
      const persist = flagBadge("persist");
      if (headed || persist) view.badge = <span className="tool-card-badges">{headed}{persist}</span>;
    }
  } else if (kind === "recall") {
    view.target = headerText("query");
  } else if (kind === "write") {
    if (typeof args.content === "string" && args.content !== "") {
      displayed.add("content");
      view.fileContent = args.content;
    }
    const pathKey = typeof args.path === "string" ? "path" : "file_path";
    if (typeof args.i !== "string" || !args.i.trim()) view.target = headerText(pathKey);
  } else {
    const action = headerText("action");
    const file = headerText("file");
    const line = file && typeof args.line === "number" ? args.line : undefined;
    if (line !== undefined) displayed.add("line");
    const location = line === undefined ? file : `${file}:${line}`;
    view.target = [action, location, headerText("symbol"), headerText("query")].filter(Boolean).join(" · ");
  }
  if (displayed.size > 0) view.args = Object.fromEntries(Object.entries(args).filter(([key]) => !displayed.has(key)));
  return view;
}

function WrittenToolCode({ text, args }: { text: string; args: Record<string, unknown> }) {
  if (text.length > MAX_MARKDOWN_CHARS) return <OversizedText>{text}</OversizedText>;
  return <pre className="tool-source-code"><ToolSyntax text={text} language={toolFileLanguage(args)} /></pre>;
}

function EvalToolCode({ text, language, cwd }: NonNullable<ToolInputView["evalCode"]> & { cwd?: string }) {
  const [raw, setRaw] = useState(false);
  const [formatted, setFormatted] = useState<{ source: string; text: string }>();
  const pythonFormat = usePythonFormatSettings();
  // JavaScript is always formatted; Python only when the user opted in and a formatter answers.
  const formatEnabled = language === "js" || pythonFormat.enabled;
  useEffect(() => {
    if (!formatEnabled || text.length > MAX_MARKDOWN_CHARS) return;
    let active = true;
    const formatting = language === "js"
      ? formatEvalJavaScript(text)
      : formatEvalPython(text, { cwd, formatter: pythonFormat.formatter });
    void formatting.then((result) => {
      if (active) setFormatted({ source: text, text: result });
    });
    return () => { active = false; };
  }, [text, language, cwd, formatEnabled, pythonFormat.formatter]);

  if (text.length > MAX_MARKDOWN_CHARS) return <OversizedText>{text}</OversizedText>;
  const preview = formatEnabled && formatted?.source === text && formatted.text !== text ? formatted.text : null;
  return <pre className="tool-source-code">
    {preview !== null && <RawToolToggle raw={raw} toggle={() => setRaw(!raw)} />}
    <ToolSyntax text={raw ? text : preview ?? text} language={language === "js" ? "javascript" : "python"} />
  </pre>;
}

const TOOL_FIELD_LABEL: CSSProperties = {
  padding: "4px 12px 4px 0",
  color: "var(--text-dim)",
  fontSize: "calc(11px + var(--chat-font-size-offset, 0px))",
  whiteSpace: "nowrap",
  verticalAlign: "top",
};

const TOOL_FIELD_VALUE: CSSProperties = {
  padding: "4px 0",
  color: "var(--text-muted)",
  fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
  fontFamily: "var(--font-mono)",
  overflowWrap: "anywhere",
};

// A value with newlines of its own keeps them, scrolled in place.
const TOOL_FIELD_BLOCK: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  maxHeight: 260,
  overflow: "auto",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  font: "inherit",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
};

function ToolFieldRows({ fields, tool, args }: { fields: ToolField[]; tool: string; args: Record<string, unknown> }) {
  return (
    <table style={{ borderCollapse: "collapse" }}>
      <tbody>
        {fields.map((field) => {
          const splitPath = field.key === "path" && toolNameIs(tool, "grep") && field.value.includes(";");
          const value = splitPath ? field.value.replace(/[ \t]*;[ \t]*/g, "\n") : field.value;
          const syntax = !splitPath && <ToolSyntax text={value} language={toolFieldLanguage(tool, args, field.key)} />;
          return <tr key={field.key}>
            <td style={TOOL_FIELD_LABEL}>{field.key}</td>
            <td style={TOOL_FIELD_VALUE}>
              {splitPath ? <span className="tool-path-list">{value}</span> : field.multiline ? <pre style={TOOL_FIELD_BLOCK}>{syntax}</pre> : syntax}
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  );
}

function formatCustomType(type: string): string {
  return type || "extension";
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  const normalizedToolName = block.toolName.toLowerCase();
  if (isIntentToolName(normalizedToolName) && typeof input.i === "string") {
    const intent = input.i.trim();
    if (intent) return intent.slice(0, 120);
  }

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}



function isIntentToolName(toolName: string): boolean {
  return ["grep", "read", "write", "glob"].some((name) =>
    toolName === name || toolName.endsWith(`.${name}`) || toolName.endsWith(`_${name}`),
  );
}


export function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}, hideCost: boolean | undefined, includeCounts: boolean): string {
  const parts = [];
  if (includeCounts) {
    if (usage.input) parts.push(`${usage.input.toLocaleString()} in`);
    if (usage.output) parts.push(`${usage.output.toLocaleString()} out`);
    if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache R`);
    if (usage.cacheWrite) parts.push(`${usage.cacheWrite.toLocaleString()} cache W`);
  }
  if (usage.cost?.total && !hideCost) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  const fullOutputUrl = sessionId && message.fullOutputPath
    ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`
    : null;
  const showFullButton = message.truncated && fullOutputUrl && fullOutput === null;
  const displayOutput = fullOutput ?? message.output;

  async function loadFullOutput() {
    if (!fullOutputUrl) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await fetch(fullOutputUrl);
      const d = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (d.success) {
        setFullOutput(d.data?.output ?? "");
      } else {
        setFullError(d.error ?? "failed");
      }
    } catch (e) {
      setFullError(String(e));
    } finally {
      setLoadingFull(false);
    }
  }

  // Reuse the terminal renderer so user-run bash matches agent-run shell output.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: "text", text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp,
      };

  return (
    <div style={{ margin: "6px 0" }}>
      <TranscriptBlock>
      <ToolCallBlock block={block} result={result} />
      {message.truncated && fullOutputUrl && (
        <div style={{ padding: "4px 10px", fontSize: 11, marginTop: -1 }}>
          {showFullButton && (
            <button
              onClick={loadFullOutput}
              disabled={loadingFull}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: loadingFull ? "default" : "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}
            >
              {loadingFull ? "loading…" : "view full output"}
            </button>
          )}
          <a
            href={`${fullOutputUrl}&download=1`}
            style={{ marginLeft: showFullButton ? 10 : 0, color: "var(--accent)", fontSize: 11, textDecoration: "underline" }}
          >
            download full output
          </a>
          {fullError && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: 11 }}>({fullError})</span>}
        </div>
      )}
      </TranscriptBlock>
    </div>
  );
}
