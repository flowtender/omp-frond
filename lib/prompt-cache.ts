/**
 * Prompt-cache status for the browser's `cache` marker (#58), from a live
 * session's own warmer or, for a session nobody has open, from its transcript.
 *
 * The transcript path mirrors omp's private `scanBranchPromptCache()` and
 * `#inferredPromptCacheEntry()` (agent-session.ts) over the SDK's exported
 * pieces and omp's own `SessionManager`, so the active branch is the one a
 * resumed session continues. The system-prompt check is the one a transcript
 * cannot make: it needs the prompt a live session would render now.
 */
import { statSync } from "node:fs";
import type { Api, Model, Usage } from "@oh-my-pi/pi-ai";
import { SessionManager, type SessionEntry, type Settings } from "@oh-my-pi/pi-coding-agent";
import {
  observedPromptCacheTier,
  promptTokensOf,
  resolvePromptCacheTier,
} from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { promptCacheStatus, type ObservedPromptCacheEntry } from "@oh-my-pi/pi-coding-agent/session/prompt-cache-status";
import { cfgProvidersCacheRetention } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import { parseModelString, splitUpstreamRouting } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { getOmpRuntime, getSettingsForCwd } from "./omp-runtime";
import type { PromptCacheInfo, PromptCacheReport } from "./prompt-cache-shared";
import { sessionPathKey } from "./session-path";

/** The part of omp's `ModelRegistry` the inference reads. */
export interface PromptCacheModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  isUsingOAuth(model: Model<Api>): boolean;
}

/** The newest assistant reply on the branch that read or wrote the prompt cache; kept small, since it is cached per file. */
interface CachedReply {
  provider: string;
  /** The requested model: a server-side fallback retags the reply with the served one. */
  model: string;
  timestamp: number;
  usage: Usage;
}

/** What a branch says about the entry its newest cached reply left (omp's `BranchPromptCacheObservation`). */
interface BranchPromptCacheObservation {
  reply: CachedReply;
  /** Send time of the latest warm refresh after the reply that left the entry cached; 0 without one. */
  warmedAt: number;
  refreshMissed: boolean;
  compacted: boolean;
}

export interface SavedPromptCacheState {
  observation: BranchPromptCacheObservation | undefined;
  /** The model the session resumes with: its branch's latest default-role `model_change`. */
  resumeModel: { provider: string; id: string } | undefined;
}

/** omp's `scanBranchPromptCache()` fold over the active branch, root first, plus the model it resumes with. */
export function observeBranchPromptCache(branch: readonly SessionEntry[]): SavedPromptCacheState {
  let observation: BranchPromptCacheObservation | undefined;
  let resumeModel: SavedPromptCacheState["resumeModel"];
  for (const entry of branch) {
    if (entry.type === "model_change" && (entry.role ?? "default") === "default") {
      const parsed = parseModelString(splitUpstreamRouting(entry.model)?.base ?? entry.model);
      if (parsed) resumeModel = { provider: parsed.provider, id: parsed.id };
    } else if (entry.type === "compaction") {
      if (observation) observation.compacted = true;
    } else if (entry.type === "reset_boundary") {
      // `/clear` starts a new transcript: nothing before the boundary is a prefix of the next request.
      observation = undefined;
    } else if (entry.type === "model_usage" && entry.cacheRefresh !== undefined) {
      // Failed, replaced and outdated refreshes carry no outcome: they say nothing about this entry.
      if (!observation) continue;
      // A refresh that wrote the prefix again left it cached from its send, as a hit does.
      const cached = entry.cacheRefresh.hit || entry.usage.cacheWrite > 0;
      observation.warmedAt = cached ? entry.cacheRefresh.sentAt : 0;
      observation.refreshMissed = !cached;
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      const reply = entry.message;
      if (reply.stopReason === "error" || reply.usage.cacheRead + reply.usage.cacheWrite <= 0) continue;
      const fallback = reply.content.find((block) => block.type === "fallback");
      observation = {
        reply: {
          provider: reply.provider,
          model: fallback?.type === "fallback" ? fallback.from.model : reply.model,
          timestamp: reply.timestamp,
          usage: reply.usage,
        },
        warmedAt: 0,
        refreshMissed: false,
        compacted: false,
      };
    }
  }
  return { observation, resumeModel };
}

/** A session file's prompt-cache state along its active branch. */
export async function readSavedPromptCacheState(filePath: string): Promise<{ state: SavedPromptCacheState; cwd: string }> {
  // A passive read: it must not move the terminal's "continue" breadcrumb.
  const manager = await SessionManager.open(filePath, undefined, undefined, { suppressBreadcrumb: true });
  return { state: observeBranchPromptCache(manager.getBranchView()), cwd: manager.getCwd() };
}

/**
 * omp's `#inferredPromptCacheEntry()` for a session read off disk. A different
 * resume model, retention tier or a later compaction is a change; the system
 * prompt the next request would render is unknown here.
 */
export function inferPromptCacheEntry(
  state: SavedPromptCacheState,
  registry: PromptCacheModelRegistry,
  retentionSetting: string,
): ObservedPromptCacheEntry | undefined {
  const { observation, resumeModel } = state;
  if (!observation) return undefined;
  const { reply } = observation;
  const model = registry.find(reply.provider, reply.model);
  if (!model) return undefined;
  const isOAuth = model.api === "anthropic-messages" && registry.isUsingOAuth(model);
  const requestedTier = resolvePromptCacheTier(
    model,
    { cacheRetention: retentionSetting === "auto" ? undefined : retentionSetting as "short" | "long" | "none" },
    isOAuth,
  );
  // A reply that used the cache wrote some tier even when the next request asks for none; a provider
  // that reports no split (Codex) wrote the default one.
  const tier = observedPromptCacheTier(reply.usage) ?? requestedTier ?? resolvePromptCacheTier(model, undefined, isOAuth);
  if (tier === undefined) return undefined;
  const seconds = model.promptCache?.[tier];
  let change: ObservedPromptCacheEntry["change"];
  if (resumeModel && (resumeModel.provider !== model.provider || resumeModel.id !== model.id)) {
    const next = registry.find(resumeModel.provider, resumeModel.id);
    change = { kind: "model", from: model.name, to: next?.name ?? resumeModel.id };
  } else if (requestedTier !== tier) {
    change = { kind: "retention" };
  } else if (observation.compacted) {
    change = { kind: "compaction" };
  }
  return {
    model,
    tier,
    touchedAt: Math.max(reply.timestamp, observation.warmedAt),
    ttlMs: seconds === undefined ? undefined : seconds * 1000,
    change,
    refreshMissed: observation.refreshMissed,
    promptTokens: promptTokensOf(reply.usage),
    inferred: true,
  };
}

function toPromptCacheInfo({ state, reason, inferred, tier, touchedAt, ttlMs, warming }: PromptCacheStatus): PromptCacheInfo {
  return { state, reason, inferred, tier, touchedAt, ttlMs, warming };
}

/** What a live session's own warmer reports; null without a warmer or a cached reply. */
export function livePromptCacheReport(
  session: { getPromptCacheStatus?(nowMs?: number, nextTokens?: number): PromptCacheStatus | undefined },
  nextTokens?: number,
): PromptCacheReport | null {
  const status = session.getPromptCacheStatus?.(Date.now(), nextTokens);
  return status ? { live: true, info: toPromptCacheInfo(status) } : null;
}

// ---------------------------------------------------------------------------
// Saved transcripts, cached per file by size and mtime: the sidebar asks for
// every session after each list reload, and only a written file changes.
// ---------------------------------------------------------------------------

interface SavedStateCacheEntry {
  fingerprint: string;
  read: { state: SavedPromptCacheState; cwd: string } | undefined;
}

declare global {
  var __ompPromptCacheStates: Map<string, SavedStateCacheEntry> | undefined;
}

function savedStateCache(): Map<string, SavedStateCacheEntry> {
  globalThis.__ompPromptCacheStates ??= new Map();
  return globalThis.__ompPromptCacheStates;
}

async function cachedSavedState(filePath: string): Promise<SavedStateCacheEntry["read"]> {
  const cache = savedStateCache();
  const key = sessionPathKey(filePath);
  let fingerprint: string;
  try {
    const stats = statSync(filePath);
    fingerprint = `${stats.size}:${stats.mtimeMs}`;
  } catch {
    cache.delete(key);
    return undefined;
  }
  const cached = cache.get(key);
  if (cached?.fingerprint === fingerprint) return cached.read;
  const read = await readSavedPromptCacheState(filePath).catch(() => undefined);
  cache.set(key, { fingerprint, read });
  return read;
}

const MAX_CONCURRENT_READS = 4;

/**
 * Status of each saved session read off its transcript, keyed by session id;
 * a session whose replies never used the cache, or whose model declares no
 * lifetime, has no entry.
 */
export async function savedPromptCacheReports(
  sessions: readonly { id: string; path: string }[],
  nowMs = Date.now(),
): Promise<Record<string, PromptCacheReport>> {
  const { modelRegistry } = await getOmpRuntime();
  const retentionByCwd = new Map<string, Promise<string>>();
  const retentionFor = (cwd: string) => {
    let retention = retentionByCwd.get(cwd);
    if (!retention) {
      retention = getSettingsForCwd(cwd).then((settings) => cfgProvidersCacheRetention.get(settings));
      retentionByCwd.set(cwd, retention);
    }
    return retention;
  };

  const reports: Record<string, PromptCacheReport> = {};
  let next = 0;
  const worker = async () => {
    while (next < sessions.length) {
      const session = sessions[next++];
      const read = await cachedSavedState(session.path);
      if (!read?.state.observation) continue;
      const report = inferredReport(read.state, modelRegistry, await retentionFor(read.cwd), nowMs);
      if (report) reports[session.id] = report;
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_READS, sessions.length) }, worker));
  return reports;
}

function inferredReport(
  state: SavedPromptCacheState,
  registry: PromptCacheModelRegistry,
  retentionSetting: string,
  nowMs: number,
): PromptCacheReport | null {
  const entry = inferPromptCacheEntry(state, registry, retentionSetting);
  const status = entry && promptCacheStatus(entry, { nowMs, nextTokens: 0 });
  return status ? { live: false, info: toPromptCacheInfo(status) } : null;
}

/** The status of a session opened without an AgentSession, for the composer of a chat that is not live. */
export async function savedSessionPromptCacheReport(manager: SessionManager, settings: Settings): Promise<PromptCacheReport | null> {
  const { modelRegistry } = await getOmpRuntime();
  return inferredReport(
    observeBranchPromptCache(manager.getBranchView()),
    modelRegistry,
    cfgProvidersCacheRetention.get(settings),
    Date.now(),
  );
}
