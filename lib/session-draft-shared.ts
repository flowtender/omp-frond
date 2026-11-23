import type { ChatDraft, ChatDraftImage } from "./draft-store";
import { MAX_ATTACHED_IMAGES, isBase64ImageWithinLimits } from "./image-attachments";
import { SESSION_ID_PATTERN } from "./session-ui-state-shared";

// Client-safe rules for the unsent composer draft shared across devices.
// Only the saved-session draft is shared; new-session draft keys never match
// SESSION_ID_PATTERN, so they stay local.

export type SharedSessionDraft = ChatDraft;

export interface StoredSessionDraft extends SharedSessionDraft {
  revision: number;
}

export interface SessionDraftSaveResponse {
  revision: number;
}

export type SessionDraftPollResponse =
  | { revision: number; unchanged: true }
  | ({ revision: number; unchanged: false } & SharedSessionDraft);

export const EMPTY_SHARED_SESSION_DRAFT: SharedSessionDraft = { value: "", images: [] };

export function sharedSessionDraftId(draftKey: string | null | undefined): string | null {
  if (!draftKey || !SESSION_ID_PATTERN.test(draftKey)) return null;
  return draftKey;
}

export function sessionDraftUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/draft`;
}

export function hasSharedSessionDraftContent(draft: SharedSessionDraft): boolean {
  return draft.value !== "" || draft.images.length > 0;
}

export function sameSharedSessionDraft(a: SharedSessionDraft, b: SharedSessionDraft): boolean {
  if (a.value !== b.value || a.images.length !== b.images.length) return false;
  return a.images.every((image, index) => {
    const other = b.images[index];
    return image.data === other.data && image.mimeType === other.mimeType;
  });
}

export type SharedSessionDraftRequest =
  | { ok: true; draft: SharedSessionDraft }
  | { ok: false; error: string };

export function parseSharedSessionDraftRequest(body: unknown): SharedSessionDraftRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Draft must be a JSON object" };
  }
  const { value, images } = body as { value?: unknown; images?: unknown };
  if (typeof value !== "string") return { ok: false, error: "Draft value must be a string" };
  if (!Array.isArray(images)) return { ok: false, error: "Draft images must be an array" };
  if (images.length > MAX_ATTACHED_IMAGES) {
    return { ok: false, error: `Draft may attach at most ${MAX_ATTACHED_IMAGES} images` };
  }
  const parsed: ChatDraftImage[] = [];
  for (const image of images) {
    if (!isBase64ImageWithinLimits(image)) {
      return { ok: false, error: "Draft image is invalid or too large" };
    }
    parsed.push({ data: image.data, mimeType: image.mimeType });
  }
  return { ok: true, draft: { value, images: parsed } };
}
