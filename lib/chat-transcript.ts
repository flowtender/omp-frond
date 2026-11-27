import { isHiddenAssistantBlock, isHiddenCustomMessage, type DisplayOptions } from "./message-display";
import { getTranscriptNotices } from "./transcript-notices";
import type { AgentMessage, AgentUsage } from "./types";

export interface AssistantTranscriptPart {
  kind: "chat" | "thinking" | "call" | "status";
  start: number;
  end: number;
  metadata?: boolean;
}

type TranscriptItem =
  | { kind: "user" | "compaction" | "input" | "event" | "model" | "user-handoff"; index: number }
  | { kind: "assistant"; index: number; part: AssistantTranscriptPart }
  | { kind: "result"; index: number; call?: { index: number; blockIndex: number } };

type TokenTotals = Pick<AgentUsage, "input" | "output" | "cacheRead" | "cacheWrite">;
type TranscriptRow = TranscriptItem | {
  kind: "fold";
  items: TranscriptItem[];
  after?: TranscriptItem;
  before?: TranscriptItem;
  requestCount: number;
  usage?: TokenTotals;
  missingUsage: boolean;
};

/** Partition the recorded exchange first. The chat projection only decides what can fold. */
export function buildChatTranscript(messages: readonly AgentMessage[], options: DisplayOptions, cacheMissMarker: boolean) {
  const items: TranscriptItem[] = [];
  let lastOutput: number | undefined;
  function handoff() {
    if (lastOutput !== undefined) items.push({ kind: "user-handoff", index: lastOutput });
    lastOutput = undefined;
  }
  const calls = new Map<string, { index: number; blockIndex: number }>();
  const results = new Set<string>();
  let lastUserIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    switch (message.role) {
      case "user":
        handoff();
        items.push({ kind: "user", index });
        lastUserIndex = index;
        break;
      case "toolResult":
        lastOutput = undefined;
        if (calls.has(message.toolCallId)) results.add(message.toolCallId);
        items.push({ kind: "result", index, call: calls.get(message.toolCallId) });
        break;
      case "bashExecution":
        lastOutput = undefined;
        items.push({ kind: message.excludeFromContext ? "event" : "input", index });
        break;
      case "custom":
        lastOutput = undefined;
        if (isHiddenCustomMessage(message)) break;
        items.push({ kind: message.customType === "compaction" ? "compaction"
          : /^(async-result|pi-web:subagent-notification|subagent-notification)$/.test(message.customType) ? "input" : "event", index });
        break;
      case "assistant": {
        items.push({ kind: "model", index });
        let part: AssistantTranscriptPart | undefined;
        for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
          const block = message.content[blockIndex];
          if (isHiddenAssistantBlock(block, options) || (block.type === "text" && !block.text.trim())) continue;
          const kind = block.type === "toolCall" ? "call" : block.type === "thinking" ? "thinking" : "chat";
          if (block.type === "toolCall") calls.set(block.toolCallId, { index, blockIndex });
          if (part?.kind === kind) {
            part.end = blockIndex + 1;
          } else {
            part = { kind, start: blockIndex, end: blockIndex + 1 };
            items.push({ kind: "assistant", index, part });
          }
        }
        if (message.stopReason === "error" || message.stopReason === "length" || (!part && cacheMissMarker && getTranscriptNotices(message).length)) {
          part = { kind: "status", start: 0, end: 0 };
          items.push({ kind: "assistant", index, part });
        }
        if (part) part.metadata = true;
        lastOutput = message.stopReason === "stop" ? index : undefined;
        break;
      }
    }
  }
  handoff();

  const rows: TranscriptRow[] = [];
  let after: TranscriptItem | undefined;
  const foldedRequests = new Set<number>();
  let gap: TranscriptItem[] = [];
  function flush(before?: TranscriptItem) {
    if (gap.length === 0) return;
    if (!before) {
      for (const item of gap) rows.push(item);
      gap = [];
      return;
    }
    // Don't fold a plain request, a trailing handoff, or the hop between those two.
    if (gap.length <= 2 && gap.every((item) => item.kind === "model" || item.kind === "user-handoff")
      && (gap.length === 1 || gap[0].kind !== gap[1].kind)) {
      for (const item of gap) rows.push(item);
    } else {
      let requestCount = 0;
      let missingUsage = false;
      let usage: TokenTotals | undefined;
      for (const item of gap) {
        if (item.kind !== "model") continue;
        const message = messages[item.index];
        if (message.role !== "assistant") continue;
        foldedRequests.add(item.index);
        requestCount++;
        if (!message.usage) { missingUsage = true; continue; }
        usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        usage.input += message.usage.input;
        usage.output += message.usage.output;
        usage.cacheRead += message.usage.cacheRead;
        usage.cacheWrite += message.usage.cacheWrite;
      }
      rows.push({ kind: "fold", items: gap, after, before, requestCount, usage, missingUsage });
    }
    gap = [];
  }
  for (const item of items) {
    const typedByUser = item.kind === "user" || (item.kind === "input" && messages[item.index].role === "bashExecution");
    if (typedByUser || (item.kind === "assistant" && item.part.kind === "chat")) {
      flush(item);
      rows.push(item);
      after = item;
    } else {
      gap.push(item);
    }
  }
  flush();
  return { rows, results, lastUserIndex, foldedRequests };
}

export type ChatTranscriptItem = TranscriptItem;
