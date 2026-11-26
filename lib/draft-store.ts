import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";
import { SESSION_ID_PATTERN } from "./session-ui-state-shared";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();

const STORAGE_PREFIX = "omp-frond:draft:";
export const MAX_STORED_DRAFTS = 50;
export const MAX_STORED_DRAFT_LENGTH = 20_000;
const seededKeys = new Set<string>();
const pendingStores = new Set<string>();
const storeHolds = new Map<string, number>();
const issuedCommands = new Map<string, string>();
let storeTimer: ReturnType<typeof setTimeout> | null = null;
let listenersAdded = false;
let storageDisabled = false;

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

function storedKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  return keys;
}

function removeStoredDraft(key: string): void {
  pendingStores.delete(key);
  try { storage()?.removeItem(STORAGE_PREFIX + key); } catch { /* storage is optional */ }
}

function readStoredDraft(key: string): ChatDraft | null {
  if (seededKeys.has(key) || !SESSION_ID_PATTERN.test(key)) return null;
  const store = storage();
  if (!store) return null;
  seededKeys.add(key);
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_PREFIX + key) ?? "null") as { text?: unknown } | null;
    if (typeof parsed?.text !== "string" || !parsed.text || parsed.text.length > MAX_STORED_DRAFT_LENGTH) return null;
    const draft = { value: parsed.text, images: [] };
    drafts.set(key, draft);
    return draft;
  } catch { return null; }
}

export function flushStoredDrafts(): void {
  if (storeTimer !== null) clearTimeout(storeTimer);
  storeTimer = null;
  const keys = [...pendingStores];
  pendingStores.clear();
  const store = storage();
  if (!store || storageDisabled) return;
  for (const key of keys) {
    const text = drafts.get(key)?.value ?? "";
    try {
      if (!text || text.length > MAX_STORED_DRAFT_LENGTH || storeHolds.has(key) || issuedCommands.get(key) === text) {
        store.removeItem(STORAGE_PREFIX + key);
        continue;
      }
      store.setItem(STORAGE_PREFIX + key, JSON.stringify({ text, at: Date.now() }));
      const entries = storedKeys(store);
      if (entries.length > MAX_STORED_DRAFTS) {
        const timestamp = (entry: string) => {
          try { return Number(JSON.parse(store.getItem(entry) ?? "null")?.at) || 0; } catch { return 0; }
        };
        entries.sort((a, b) => timestamp(b) - timestamp(a));
        entries.slice(MAX_STORED_DRAFTS).forEach((entry) => store.removeItem(entry));
      }
    } catch {
      try { store.removeItem(STORAGE_PREFIX + key); } catch { /* storage is optional */ }
    }
  }
}

function scheduleStoredDraft(key: string): void {
  if (storageDisabled || !SESSION_ID_PATTERN.test(key) || storeHolds.has(key) || !storage()) return;
  pendingStores.add(key);
  if (!listenersAdded) {
    listenersAdded = true;
    window.addEventListener("pagehide", flushStoredDrafts);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushStoredDrafts();
    });
  }
  if (storeTimer === null) storeTimer = setTimeout(flushStoredDrafts, 300);
}

export function holdStoredDraft(key: string): () => void {
  storeHolds.set(key, (storeHolds.get(key) ?? 0) + 1);
  removeStoredDraft(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (storeHolds.get(key) ?? 1) - 1;
    if (count) storeHolds.set(key, count);
    else {
      storeHolds.delete(key);
      if (drafts.get(key)?.value) scheduleStoredDraft(key);
    }
  };
}

export function suppressIssuedCommandDraft(key: string, text: string): void {
  issuedCommands.set(key, text);
  removeStoredDraft(key);
}

export function clearStoredDrafts(): void {
  storageDisabled = true;
  pendingStores.clear();
  const store = storage();
  if (!store) return;
  try { storedKeys(store).forEach((key) => store.removeItem(key)); } catch { /* storage is optional */ }
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key) ?? readStoredDraft(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    clearDraft(key);
    return;
  }
  seededKeys.add(key);
  const previous = drafts.get(key);
  if (issuedCommands.has(key) && issuedCommands.get(key) !== draft.value) issuedCommands.delete(key);
  drafts.set(key, cloneDraft(draft));
  if (!draft.value) removeStoredDraft(key);
  else if (previous?.value !== draft.value) scheduleStoredDraft(key);
}

export function clearDraft(key: string): void {
  seededKeys.add(key);
  issuedCommands.delete(key);
  drafts.delete(key);
  removeStoredDraft(key);
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
