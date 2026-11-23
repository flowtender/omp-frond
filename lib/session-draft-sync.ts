import { getDraft, setDraft } from "@/lib/draft-store";
import {
  EMPTY_SHARED_SESSION_DRAFT,
  hasSharedSessionDraftContent,
  type SessionDraftPollResponse,
  type SessionDraftSaveResponse,
  type SharedSessionDraft,
  sameSharedSessionDraft,
  sessionDraftUrl,
} from "./session-draft-shared";

// Keeps one saved session's unsent draft in step with the server copy.
//
// Model: the server holds one draft per session with a revision that only
// grows. The composer's draft (lib/draft-store.ts) is what the user has typed.
// A remote snapshot is adopted only while the composer matches the last
// snapshot this device saw (nothing unsent here), so typing is never
// overwritten. Otherwise the local draft is saved over the remote one: last
// write wins on the server.

export interface SessionDraftTransport {
  poll(sessionId: string, since: number | null): Promise<SessionDraftPollResponse>;
  save(sessionId: string, draft: SharedSessionDraft): Promise<SessionDraftSaveResponse>;
}

// The composer, while it is on screen for this session. Without it, the
// draft store is read and written directly.
export interface SessionDraftComposer {
  readDraft(): SharedSessionDraft;
  applyRemoteDraft(draft: SharedSessionDraft): void;
}

export interface SessionDraftSyncOptions {
  debounceMs: number;
  retryMs: number;
}

const DEFAULT_OPTIONS: SessionDraftSyncOptions = { debounceMs: 400, retryMs: 5000 };

// Thrown by a transport when the session no longer exists; retrying cannot succeed.
export class SessionDraftGoneError extends Error {}

export class SessionDraftSync {
  private readonly sessionId: string;
  private readonly transport: SessionDraftTransport;
  private readonly options: SessionDraftSyncOptions;
  private composer: SessionDraftComposer | null = null;
  // False until the first full read of the server draft.
  private baselined = false;
  // Highest revision applied or acknowledged; revisions never move back.
  private known = 0;
  // What the server holds at `known`; null while evicted (see settle()).
  private server: SharedSessionDraft | null = EMPTY_SHARED_SESSION_DRAFT;
  // The composer's text when the first read began; tells text changed during that read from text restored earlier.
  private opening: SharedSessionDraft | null = null;
  // Set once the session is gone; nothing else runs for this instance.
  private retired = false;
  private polling = false;
  private saving = false;
  private scheduled = false;

  constructor(sessionId: string, transport: SessionDraftTransport, options: SessionDraftSyncOptions = DEFAULT_OPTIONS) {
    this.sessionId = sessionId;
    this.transport = transport;
    this.options = options;
  }

  attach(composer: SessionDraftComposer): void {
    this.composer = composer;
    // Evicted while idle: the store was not written since, so it holds what the server holds.
    if (this.baselined && this.server === null && !this.retired) {
      this.server = getDraft(this.sessionId) ?? EMPTY_SHARED_SESSION_DRAFT;
    }
  }

  detach(composer: SessionDraftComposer): void {
    if (this.composer === composer) this.composer = null;
  }

  /** Schedules a save of the local draft shortly; repeated calls share one timer. */
  kick(): void {
    this.schedule(this.options.debounceMs);
  }

  /** Applies the newest server draft when clean, then saves any local draft. */
  async refresh(): Promise<void> {
    if (this.polling || this.retired) return;
    this.polling = true;
    try {
      // The first read remembers the composer's text, so text typed or restored before it can be told apart.
      if (!this.baselined) this.opening ??= this.readLocal();
      // While the composer holds unsent text, skip the poll and save ours.
      if (!this.baselined || !this.isDirty()) {
        this.receive(await this.transport.poll(this.sessionId, this.baselined ? this.known : null));
      }
    } catch (error) {
      if (error instanceof SessionDraftGoneError) {
        this.retire();
        return;
      }
      // Keep the local draft; the next refresh asks again.
    } finally {
      this.polling = false;
    }
    await this.flush();
  }

  private readLocal(): SharedSessionDraft {
    if (this.composer) return this.composer.readDraft();
    return getDraft(this.sessionId) ?? EMPTY_SHARED_SESSION_DRAFT;
  }

  private applyLocal(draft: SharedSessionDraft): void {
    if (this.composer) this.composer.applyRemoteDraft(draft);
    else setDraft(this.sessionId, draft);
  }

  // Dirty means the local draft differs from the content this device last saw or sent.
  // Compared with `server`, so an unsaved clear counts as dirty too.
  private isDirty(): boolean {
    if (this.server === null) return false;
    return !sameSharedSessionDraft(this.readLocal(), this.server);
  }

  private receive(response: SessionDraftPollResponse): void {
    if (response.unchanged) return;
    const remote: SharedSessionDraft = { value: response.value, images: response.images };
    if (!this.baselined) {
      const local = this.readLocal();
      // Unsent when the composer holds text, or changed since the first read began (a clear counts).
      const opening = this.opening ?? EMPTY_SHARED_SESSION_DRAFT;
      const unsent = hasSharedSessionDraftContent(local) || !sameSharedSessionDraft(local, opening);
      this.opening = null;
      this.baselined = true;
      this.known = response.revision;
      this.server = remote;
      // Unsent local text wins; flush() saves it over the remote draft.
      if (!unsent) this.adopt(remote);
      return;
    }
    if (response.revision <= this.known || this.saving || this.isDirty()) return;
    this.known = response.revision;
    this.server = remote;
    this.adopt(remote);
  }

  private adopt(remote: SharedSessionDraft): void {
    if (!sameSharedSessionDraft(this.readLocal(), remote)) this.applyLocal(remote);
  }

  private async flush(): Promise<void> {
    if (this.saving || this.retired || !this.baselined || this.server === null) return;
    if (!this.isDirty()) {
      this.settle();
      return;
    }
    const draft = this.readLocal();
    this.saving = true;
    let saved = false;
    try {
      const stored = await this.transport.save(this.sessionId, draft);
      this.known = Math.max(this.known, stored.revision);
      this.server = draft;
      saved = true;
    } catch (error) {
      if (error instanceof SessionDraftGoneError) {
        this.retire();
        return;
      }
      // Keep the local draft; retried below after a pause rather than in a tight loop.
    } finally {
      this.saving = false;
    }
    if (!saved) {
      this.schedule(this.options.retryMs);
      return;
    }
    // Text typed while the save was in flight goes out in a follow-up save.
    if (this.isDirty()) this.kick();
    else this.settle();
  }

  // Once nothing is pending and no composer shows the session, the held copy is dropped.
  // attach() restores it from the store, which by then holds the same content.
  private settle(): void {
    if (this.composer || this.polling || this.saving || this.scheduled || this.retired) return;
    if (!this.baselined || this.server === null || this.isDirty()) return;
    this.server = null;
  }

  // The session no longer exists: stop polling, saving and retrying, and drop the copies.
  private retire(): void {
    this.retired = true;
    this.composer = null;
    this.server = null;
    this.opening = null;
  }

  private schedule(ms: number): void {
    if (this.scheduled || this.retired) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      void this.flush();
    }, ms);
  }
}

const httpTransport: SessionDraftTransport = {
  async poll(sessionId, since) {
    const query = since === null ? "" : `?since=${since}`;
    const response = await fetch(`${sessionDraftUrl(sessionId)}${query}`, { cache: "no-store" });
    if (response.status === 404) throw new SessionDraftGoneError();
    if (!response.ok) throw new Error(`Draft poll failed: ${response.status}`);
    return (await response.json()) as SessionDraftPollResponse;
  },
  async save(sessionId, draft) {
    const response = await fetch(sessionDraftUrl(sessionId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (response.status === 404) throw new SessionDraftGoneError();
    if (!response.ok) throw new Error(`Draft save failed: ${response.status}`);
    return (await response.json()) as SessionDraftSaveResponse;
  },
};

// One instance per session, kept across composer remounts so a pending save
// still runs after the composer that made it has gone.
const syncs = new Map<string, SessionDraftSync>();

export function getSessionDraftSync(sessionId: string): SessionDraftSync {
  let sync = syncs.get(sessionId);
  if (!sync) {
    sync = new SessionDraftSync(sessionId, httpTransport);
    syncs.set(sessionId, sync);
  }
  return sync;
}
