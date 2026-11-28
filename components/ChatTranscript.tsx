import type { ReactNode, Ref, RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TokenDisplayMode } from "@/hooks/useTokenDisplay";
import { getVisibleRenderWindow } from "@/lib/chat-lazy-load";
import type { buildChatTranscript, ChatTranscriptItem } from "@/lib/chat-transcript";
import { isMessageGroupAnchor } from "@/lib/message-display";
import { toolCallFailureCount } from "@/lib/tool-call-expansion";
import { getTranscriptNotices, summarizeCacheMisses } from "@/lib/transcript-notices";
import { getTurnDurationMs } from "@/lib/turn-duration";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolResultMessage, UserMessage } from "@/lib/types";
import { formatTime, formatUsage, getModelDisplayName, handoffTimeOf, MessageView, TranscriptToolResult } from "./MessageView";
import { ProcessDetailsGroup } from "./ProcessDetailsGroup";
import { TokenFlow, TokenFlowHandoff } from "./TokenFlow";
import { TranscriptGrowth } from "./TranscriptGrowth";
import { TranscriptNoticeLines } from "./TranscriptNotices";
import { TranscriptViewportRow } from "./TranscriptViewportRow";

interface Props {
  transcript: ReturnType<typeof buildChatTranscript>;
  messages: AgentMessage[];
  entryIds: readonly string[];
  messageKeys: readonly string[];
  toolResultsMap: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  messageCwd?: string;
  sessionId?: string;
  tokenDisplay: TokenDisplayMode;
  showTokenFlow: boolean;
  cacheMissMarker: boolean;
  hideCost: boolean;
  loading: boolean;
  restoringScroll: boolean;
  sessionBusy: boolean;
  isStreaming: boolean;
  visibleReplyStarts: RefObject<ReadonlySet<number>>;
  latestPromptRef?: Ref<HTMLDivElement>;
  searchEntryId?: string;
  searchBlock?: AssistantContentBlock;
  restoreEntryId?: string;
  editEntryId?: string | null;
  forkingEntryId?: string | null;
  onFork?: (entryId: string) => void;
  onEditContent?: (message: UserMessage, entryId: string) => void;
  onCancelEdit?: () => void;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  onCompact?: () => void;
  isCompacting: boolean;
  compactError?: string | null;
  visibleCount: number;
  hasEarlierMessages: boolean;
  earlierTurnCount: number;
  earlierSentinelRef?: Ref<HTMLDivElement>;
}

export function ChatTranscript({
  transcript, messages, entryIds, messageKeys, toolResultsMap, modelNames, messageCwd, sessionId,
  tokenDisplay, showTokenFlow, cacheMissMarker, hideCost, loading, restoringScroll, sessionBusy, isStreaming,
  visibleReplyStarts, latestPromptRef, searchEntryId, searchBlock, restoreEntryId, editEntryId, forkingEntryId,
  onFork, onEditContent, onCancelEdit, onOpenFile, onOpenSubagent, onCompact, isCompacting, compactError,
  visibleCount, hasEarlierMessages, earlierTurnCount, earlierSentinelRef,
}: Props) {
  const { t } = useI18n();
  const { rows, results, lastUserIndex: lastUserIdx, foldedRequests } = transcript;

  const pinMessage = (idx: number) => {
    const id = entryIds[idx];
    return idx === lastUserIdx || Boolean(id && (
      id === searchEntryId || id === restoreEntryId || id === editEntryId
    ));
  };

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
    const arriving = !loading && !restoringScroll && idx >= lastUserIdx && !entryIds[idx];
    const wasStreamed = msg.role === "assistant" && msg.timestamp !== undefined && visibleReplyStarts.current.has(msg.timestamp);
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
        searchBlock={entryIds[idx] === searchEntryId ? searchBlock : undefined}
        onFork={onFork}
        forking={forkingEntryId === entryIds[idx]}
        onEditContent={onEditContent}
        onCancelEdit={onCancelEdit}
        isEditing={editEntryId === entryIds[idx]}
        showTimestamp={part?.metadata}
        prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
        sessionId={sessionId}
        writtenFiles={writtenFiles}
        turnDurationMs={turnDurationMs}
        onCompact={part?.kind === "status" && idx === messages.length - 1 && !isStreaming ? onCompact : undefined}
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
    const port = item.kind === "input" && msg.role !== "custom" ? "input" : undefined;
    const canReveal = item.kind === "user" || item.kind === "compaction" || item.kind === "input"
      || part?.kind === "chat" || part?.kind === "status";
    return (
      <div key={key} data-entry-id={entryIds[idx]}
        data-transcript-port={port}
        data-chat-scroll-anchor={entryIds[idx] && (isMessageGroupAnchor(msg) || part?.kind === "chat") ? "" : undefined}
        ref={item.kind === "user" && idx === lastUserIdx ? latestPromptRef : undefined}>
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
    const reveal = Boolean(searchEntryId || restoreEntryId) && row.items.some((item) => matches(item, searchEntryId, searchBlock)
      || matches(item, restoreEntryId));
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
        <div ref={earlierSentinelRef} className="py-3 text-center text-xs text-text-muted">
          {t("chat.loadEarlier", { count: earlierTurnCount })}
        </div>
      )}
      {rendered.slice(startIndex).map(({ key, pinned, render }, index) => (
        <TranscriptViewportRow key={key} pinned={pinned || index + startIndex >= rendered.length - 2} render={render} />
      ))}
    </>
  );
}
