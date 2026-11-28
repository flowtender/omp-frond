import type { SessionEntry as OmpSessionEntry } from "@oh-my-pi/pi-coding-agent";
import { findCacheMisses } from "./cache-miss-markers";
import { withTranscriptNotices, type TranscriptNotice } from "./transcript-notices";
import type { SessionEntry } from "./types";

// The session entries that sit beside the conversation (model calls outside it,
// model, thinking-level and service-tier changes) as notices on the message
// they follow. They are derived on every history read, never persisted, and
// always sent: the browser decides which kinds it draws.

type NoticesByEntry = Map<string, TranscriptNotice[]>;

function noticeOf(entry: OmpSessionEntry): TranscriptNotice | undefined {
  switch (entry.type) {
    case "model_usage":
      return { kind: "model_usage", purpose: entry.purpose, model: `${entry.provider}/${entry.model}`, totalTokens: entry.usage.totalTokens };
    case "model_change":
      return { kind: "model_change", model: entry.model, role: entry.role ?? "default" };
    case "thinking_level_change":
      return { kind: "thinking_level_change", level: entry.configured ?? entry.thinkingLevel ?? "off" };
    case "service_tier_change":
      return { kind: "service_tier_change", serviceTier: { ...entry.serviceTier } as Record<string, string> };
    default:
      return undefined;
  }
}

function addNotice(notices: NoticesByEntry, entryId: string, notice: TranscriptNotice): void {
  const list = notices.get(entryId);
  if (list) list.push(notice);
  else notices.set(entryId, [notice]);
}

/**
 * The notices of the branch ending at `leafId`, keyed by the id of the message
 * each follows. A change belongs to the nearest message before it on the branch
 * (none before the first message: nothing to hang it on). A `model_usage`
 * entry is a child of the entry its call started from, off the branch, so it
 * follows the message in effect at its parent; one whose parent is on another
 * branch is skipped.
 */
export function findMetadataNotices(entries: readonly SessionEntry[], leafId: string | null): NoticesByEntry {
  const notices: NoticesByEntry = new Map();
  if (leafId === null) return notices;
  const ompEntries = entries as unknown as OmpSessionEntry[];
  const byId = new Map(ompEntries.map((entry) => [entry.id, entry]));

  const branch: OmpSessionEntry[] = [];
  const seen = new Set<string>();
  for (let entry = byId.get(leafId); entry && !seen.has(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
    seen.add(entry.id);
    branch.push(entry);
  }
  branch.reverse();

  const carrierAt = new Map<string, string | undefined>();
  let carrier: string | undefined;
  for (const entry of branch) {
    // Notices hang on the user and assistant messages the chat draws a line under.
    if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
      carrier = entry.id;
    } else if (entry.type !== "model_usage" && carrier) {
      const notice = noticeOf(entry);
      if (notice) addNotice(notices, carrier, notice);
    }
    carrierAt.set(entry.id, carrier);
  }

  for (const entry of ompEntries) {
    if (entry.type !== "model_usage" || !entry.parentId) continue;
    const owner = carrierAt.get(entry.parentId);
    const notice = noticeOf(entry);
    if (owner && notice) addNotice(notices, owner, notice);
  }
  return notices;
}

/** Every notice of the branch ending at `leafId`: its cache misses first, then the entries beside the conversation. */
export function findTranscriptNotices(entries: readonly SessionEntry[], leafId: string | null): NoticesByEntry {
  const notices = findMetadataNotices(entries, leafId);
  for (const [entryId, miss] of findCacheMisses(entries, leafId)) {
    const list = notices.get(entryId);
    if (list) list.unshift(miss);
    else notices.set(entryId, [miss]);
  }
  return notices;
}

/** `context` with each message carrying its entry's notices. */
export function attachTranscriptNotices<T extends { messages: unknown[]; entryIds: string[] }>(
  context: T,
  notices: NoticesByEntry,
): T {
  if (notices.size === 0) return context;
  const messages = context.messages.map((message, index) => withTranscriptNotices(message as object, notices.get(context.entryIds[index])));
  return { ...context, messages };
}
