import { buildSessionContext as ompBuildSessionContext, type SessionEntry as OmpSessionEntry } from "@oh-my-pi/pi-coding-agent";
import { detectCacheInvalidation } from "@oh-my-pi/pi-coding-agent/session/transcript/cache-invalidation-marker";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "./types";
import { withTranscriptNotices, type TranscriptNotice } from "./transcript-notices";

// omp's cache-miss marker (`display.cacheMissMarker`), derived from the session
// entries the way the TUI's transcript replay derives it
// (`modes/utils/ui-helpers.ts`): omp's own `detectCacheInvalidation()` against
// the previous assistant turn that used any prompt tokens, skipping turns omp's
// transcript context marks as explained (`cacheMissExplainedAt`: a compaction,
// a model change or a plan-mode switch came first). The marker is never
// persisted, so every history read and every live reply derives it again.
// It is computed whatever the setting says; the chat hides it while it is off.

const LIVE_ENTRY_ID = "omp-web:live-assistant";

type AssistantMessage = Extract<OmpSessionEntry, { type: "message" }>["message"] & { role: "assistant"; usage: Usage };

function isAssistantEntry(entry: OmpSessionEntry): entry is Extract<OmpSessionEntry, { type: "message" }> & { message: AssistantMessage } {
  return entry.type === "message" && entry.message.role === "assistant";
}

/** The ids of the assistant entries on the branch to `leafId` that a `/clear` separates from every earlier turn. */
function firstAssistantsAfterClear(byId: Map<string, OmpSessionEntry>, leafId: string): Set<string> {
  const branch: OmpSessionEntry[] = [];
  for (let entry = byId.get(leafId); entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.push(entry);
  const ids = new Set<string>();
  let afterClear = false;
  for (const entry of branch.reverse()) {
    if (entry.type === "reset_boundary") afterClear = true;
    else if (afterClear && isAssistantEntry(entry)) {
      ids.add(entry.id);
      afterClear = false;
    }
  }
  return ids;
}

/** The cache-miss marker of every assistant entry on the branch ending at `leafId`, keyed by entry id. */
export function findCacheMisses(entries: readonly SessionEntry[], leafId: string | null): Map<string, TranscriptNotice> {
  const misses = new Map<string, TranscriptNotice>();
  if (leafId === null) return misses;
  const ompEntries = entries as unknown as OmpSessionEntry[];
  const byId = new Map<string, OmpSessionEntry>();
  const entryIdByMessage = new Map<unknown, string>();
  for (const entry of ompEntries) {
    byId.set(entry.id, entry);
    if (entry.type === "message") entryIdByMessage.set(entry.message, entry.id);
  }
  // The display transcript keeps compacted history, which the chat shows too.
  const context = ompBuildSessionContext(ompEntries, leafId, byId, { transcript: true });
  // omp's TUI drops the turns before a `/clear` from its transcript, so the
  // first turn after one has no predecessor to have lost a cache against.
  const afterClear = firstAssistantsAfterClear(byId, leafId);

  let previousUsage: Usage | undefined;
  context.messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const entryId = entryIdByMessage.get(message);
    if (entryId && afterClear.has(entryId)) previousUsage = undefined;
    const usage = (message as AssistantMessage).usage;
    if (entryId && !context.cacheMissExplainedAt?.[index]) {
      const invalidation = detectCacheInvalidation(previousUsage, usage);
      if (invalidation) misses.set(entryId, { kind: "cache_miss", reprocessedTokens: invalidation.reprocessedTokens });
    }
    if (usage.cacheRead + usage.cacheWrite + usage.input > 0) previousUsage = usage;
  });
  return misses;
}

/** `context` with each message carrying its entry's cache-miss marker. */
export function attachCacheMisses<T extends { messages: unknown[]; entryIds: string[] }>(
  context: T,
  misses: Map<string, TranscriptNotice>,
): T {
  if (misses.size === 0) return context;
  const messages = context.messages.map((message, index) => {
    const miss = misses.get(context.entryIds[index]);
    return miss ? withTranscriptNotices(message as object, [miss]) : message;
  });
  return { ...context, messages };
}

/**
 * The marker of an assistant reply that just ended, as the next history read
 * will show it. omp persists a reply around its `message_end`, so the reply is
 * read from the branch when it is already the leaf, and placed after the leaf
 * otherwise.
 */
export function findLiveCacheMiss(
  entries: readonly SessionEntry[],
  leafId: string | null,
  message: { role: string; timestamp?: number },
): TranscriptNotice | undefined {
  const leaf = leafId ? (entries as unknown as OmpSessionEntry[]).find((entry) => entry.id === leafId) : undefined;
  if (leaf && isAssistantEntry(leaf) && leaf.message.timestamp === message.timestamp) {
    return findCacheMisses(entries, leafId).get(leaf.id);
  }
  const live = {
    type: "message",
    id: LIVE_ENTRY_ID,
    parentId: leafId,
    timestamp: new Date().toISOString(),
    message,
  } as unknown as SessionEntry;
  return findCacheMisses([...entries, live], LIVE_ENTRY_ID).get(LIVE_ENTRY_ID);
}
