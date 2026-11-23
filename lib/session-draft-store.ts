import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  type SharedSessionDraft,
  type StoredSessionDraft,
  parseSharedSessionDraftRequest,
} from "./session-draft-shared";
import { SESSION_ID_PATTERN } from "./session-ui-state-shared";

// One JSON file per saved session under <agentDir>/pi-web-drafts/. Every write
// bumps `revision`; clearing writes an empty record instead of deleting the
// file so revisions never move backwards and clients can tell a clear apart
// from a session that never had a draft.
//
// Reads and writes are synchronous, so a read-modify-write cannot interleave
// with another request in this process.

const DRAFTS_DIR_NAME = "pi-web-drafts";

const parsedCache = new Map<string, { stamp: string; record: StoredSessionDraft }>();

// Bounded: every entry holds a parsed draft, images included.
const PARSED_CACHE_LIMIT = 16;

function draftPath(sessionId: string, agentDir: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  return join(agentDir, DRAFTS_DIR_NAME, `${sessionId}.json`);
}

/** The oldest insertion goes first when the cache is full; a miss only costs a re-read. */
function rememberParsed(path: string, entry: { stamp: string; record: StoredSessionDraft }): void {
  parsedCache.delete(path);
  parsedCache.set(path, entry);
  while (parsedCache.size > PARSED_CACHE_LIMIT) {
    const oldest = parsedCache.keys().next().value;
    if (oldest === undefined) break;
    parsedCache.delete(oldest);
  }
}

function fileStamp(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseStoredDraft(text: string, path: string): StoredSessionDraft {
  const corrupt = () => new Error(`Session draft file is unreadable: ${path}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw corrupt();
  }
  const revision = (body as { revision?: unknown } | null)?.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw corrupt();
  }
  const parsed = parseSharedSessionDraftRequest(body);
  if (!parsed.ok) throw corrupt();
  return { revision, ...parsed.draft };
}

/** Throws when the stored file is unreadable; callers must not overwrite it. */
export function readSessionDraft(
  sessionId: string,
  agentDir: string = getAgentDir(),
): StoredSessionDraft {
  const path = draftPath(sessionId, agentDir);
  const stamp = fileStamp(path);
  if (stamp === null) return { revision: 0, value: "", images: [] };
  const cached = parsedCache.get(path);
  if (cached?.stamp === stamp) return cached.record;
  const record = parseStoredDraft(readFileSync(path, "utf8"), path);
  rememberParsed(path, { stamp, record });
  return record;
}

export function writeSessionDraft(
  sessionId: string,
  draft: SharedSessionDraft,
  agentDir: string = getAgentDir(),
): StoredSessionDraft {
  const path = draftPath(sessionId, agentDir);
  const current = readSessionDraft(sessionId, agentDir);
  const record: StoredSessionDraft = {
    revision: current.revision + 1,
    value: draft.value,
    images: draft.images.map((image) => ({ data: image.data, mimeType: image.mimeType })),
  };
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(record)}\n`);
  parsedCache.delete(path);
  return record;
}

/** Deletes the unsent drafts of deleted sessions; ids that are not session ids are skipped. */
export function forgetSessionDrafts(sessionIds: Iterable<string>, agentDir: string = getAgentDir()): void {
  for (const sessionId of sessionIds) {
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    const path = draftPath(sessionId, agentDir);
    parsedCache.delete(path);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
