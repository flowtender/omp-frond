import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(i) { return [...this.values.keys()][i] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const storage = new MemoryStorage();
globalThis.window = Object.assign(new EventTarget(), { localStorage: storage });
globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
const load = () => createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false }).import("@/lib/draft-store");
const store = await load();
const key = (id) => `omp-frond:draft:${id}`;

test("session drafts survive reload as text only, and flush on hide", async () => {
  store.setDraft("draft-a", { value: "unsent", images: [{ data: "AAAA", mimeType: "image/png" }] });
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  document.visibilityState = "visible";
  assert.equal(JSON.parse(storage.getItem(key("draft-a"))).text, "unsent");
  assert.deepEqual((await load()).getDraft("draft-a"), { value: "unsent", images: [] });
  store.clearDraft("draft-a");
  assert.equal((await load()).getDraft("draft-a"), null);
});

test("recovered submission preserves text typed afterward", () => {
  store.setDraft("recovery-session", { value: "new text", images: [] });
  store.restoreDraftSubmission("recovery-session", "submitted");
  assert.equal(store.getDraft("recovery-session").value, "submitted\n\nnew text");
  store.clearDraft("recovery-session");
});

test("fresh keys, oversized text, and held edits are not persisted", () => {
  store.setDraft("new:1:/project", { value: "new", images: [] });
  store.setDraft("draft-long", { value: "x".repeat(store.MAX_STORED_DRAFT_LENGTH + 1), images: [] });
  store.setDraft("draft-held", { value: "old", images: [] });
  store.flushStoredDrafts();
  const release = store.holdStoredDraft("draft-held");
  store.setDraft("draft-held", { value: "edit", images: [] });
  window.dispatchEvent(new Event("pagehide"));
  assert.equal(storage.getItem(key("new:1:/project")), null);
  assert.equal(storage.getItem(key("draft-long")), null);
  assert.equal(storage.getItem(key("draft-held")), null);
  release();
  store.flushStoredDrafts();
  assert.equal(JSON.parse(storage.getItem(key("draft-held"))).text, "edit");
  store.clearDraft("draft-held");
});

test("an issued command stays in memory but is not persisted until edited", async () => {
  store.setDraft("command-session", { value: "/reload", images: [] });
  store.flushStoredDrafts();
  const release = store.holdStoredDraft("command-session");
  store.suppressIssuedCommandDraft("command-session", "/reload");
  release();
  store.flushStoredDrafts();
  assert.equal(storage.getItem(key("command-session")), null);
  assert.equal(store.getDraft("command-session").value, "/reload");
  store.setDraft("command-session", { value: "/reload changed", images: [] });
  store.flushStoredDrafts();
  assert.equal((await load()).getDraft("command-session").value, "/reload changed");
  store.clearDraft("command-session");
});

test("bounded storage evicts old drafts and logout cancels pending writes", () => {
  storage.values.clear();
  for (let i = 0; i < store.MAX_STORED_DRAFTS; i++) storage.setItem(key(`old-${i}`), JSON.stringify({ text: "old", at: i + 1 }));
  store.setDraft("newest-draft", { value: "newest", images: [] });
  store.flushStoredDrafts();
  assert.equal(storage.getItem(key("old-0")), null);
  assert.equal(storage.length, store.MAX_STORED_DRAFTS);
  store.setDraft("pending-draft", { value: "pending", images: [] });
  store.clearStoredDrafts();
  store.flushStoredDrafts();
  store.setDraft("after-logout", { value: "must not return", images: [] });
  window.dispatchEvent(new Event("pagehide"));
  assert.equal(storage.length, 0);
});
