import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});
const { clearDraft, getDraft, setDraft } = await jiti.import("@/lib/draft-store");
const { SessionDraftGoneError, SessionDraftSync, getSessionDraftSync } = await jiti.import("./session-draft-sync.ts");

const PNG = { data: "aGk=", mimeType: "image/png" };
const FAST = { debounceMs: 0, retryMs: 1 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An in-memory server with the same revision rules as the route: every save
// bumps the revision; a poll with the current revision answers unchanged.
// `gone` makes every request answer like a deleted session (404).
function fakeServer(state = { revision: 0, value: "", images: [] }) {
  const server = {
    state: { ...state },
    polls: 0,
    attempts: 0,
    saves: [],
    failSaves: 0,
    gate: null,
    pollGate: null,
    gone: false,
  };
  server.transport = {
    async poll(_sessionId, since) {
      server.polls += 1;
      if (server.gone) throw new SessionDraftGoneError();
      const { revision, value, images } = server.state;
      if (server.pollGate) await server.pollGate;
      return since === revision ? { revision, unchanged: true } : { revision, unchanged: false, value, images };
    },
    async save(_sessionId, draft) {
      server.attempts += 1;
      if (server.gone) throw new SessionDraftGoneError();
      if (server.failSaves > 0) {
        server.failSaves -= 1;
        throw new Error("offline");
      }
      if (server.gate) await server.gate;
      server.saves.push(draft.value);
      server.state = { revision: server.state.revision + 1, value: draft.value, images: draft.images };
      return { revision: server.state.revision };
    },
  };
  return server;
}

// A composer that edits the store copy, as ChatInput does through useSharedSessionDraft.
function storeComposer(sessionId) {
  return {
    readDraft: () => getDraft(sessionId) ?? { value: "", images: [] },
    applyRemoteDraft: (draft) => setDraft(sessionId, draft),
  };
}

test("the registry keeps one sync per session across composer remounts", () => {
  assert.equal(getSessionDraftSync("registry-a"), getSessionDraftSync("registry-a"));
  assert.notEqual(getSessionDraftSync("registry-a"), getSessionDraftSync("registry-b"));
});

test("an empty composer adopts the server draft, text and images, without saving", async () => {
  const server = fakeServer({ revision: 3, value: "from the laptop", images: [PNG] });
  const sync = new SessionDraftSync("sync-adopt", server.transport, FAST);
  await sync.refresh();
  assert.deepEqual(getDraft("sync-adopt"), { value: "from the laptop", images: [PNG] });
  assert.equal(server.attempts, 0);
});

test("unsent local text wins over the server draft at the first read and is saved", async () => {
  setDraft("sync-local-wins", { value: "typed here", images: [] });
  const server = fakeServer({ revision: 2, value: "remote", images: [] });
  const sync = new SessionDraftSync("sync-local-wins", server.transport, FAST);
  await sync.refresh();
  assert.deepEqual(server.saves, ["typed here"]);
  assert.equal(server.state.revision, 3);
  assert.equal(getDraft("sync-local-wins").value, "typed here");
});

test("clearing while the first read is pending saves the clear instead of adopting the server draft", async () => {
  const server = fakeServer({ revision: 2, value: "remote", images: [] });
  let releasePoll;
  server.pollGate = new Promise((resolve) => {
    releasePoll = resolve;
  });
  const sync = new SessionDraftSync("sync-clear-first", server.transport, FAST);
  setDraft("sync-clear-first", { value: "typed", images: [] });

  const pending = sync.refresh();
  await sleep(5);
  clearDraft("sync-clear-first");
  releasePoll();
  await pending;
  await sleep(20);

  assert.deepEqual(server.saves, [""]);
  assert.equal(server.state.revision, 3);
  assert.equal(getDraft("sync-clear-first")?.value ?? "", "");
});

test("a clean composer follows newer server revisions", async () => {
  const server = fakeServer({ revision: 1, value: "first", images: [] });
  const sync = new SessionDraftSync("sync-follow", server.transport, FAST);
  await sync.refresh();
  assert.equal(getDraft("sync-follow").value, "first");

  server.state = { revision: 4, value: "newer from phone", images: [] };
  await sync.refresh();
  assert.equal(getDraft("sync-follow").value, "newer from phone");
  assert.equal(server.attempts, 0);
});

test("a composer with unsent text does not poll and keeps its text", async () => {
  const server = fakeServer({ revision: 1, value: "first", images: [] });
  const sync = new SessionDraftSync("sync-typing", server.transport, FAST);
  const composer = storeComposer("sync-typing");
  sync.attach(composer);
  await sync.refresh();
  const polls = server.polls;

  setDraft("sync-typing", { value: "still typing", images: [] });
  server.state = { revision: 2, value: "other device", images: [] };
  await sync.refresh();

  assert.equal(server.polls, polls, "no poll while dirty");
  assert.deepEqual(server.saves, ["still typing"]);
  assert.equal(getDraft("sync-typing").value, "still typing");
  sync.detach(composer);
});

test("a failed save keeps the local draft and retries", async () => {
  const server = fakeServer();
  server.failSaves = 1;
  const sync = new SessionDraftSync("sync-retry", server.transport, FAST);
  setDraft("sync-retry", { value: "keep me", images: [] });

  await sync.refresh();
  assert.equal(server.attempts, 1);
  assert.equal(server.state.revision, 0);
  assert.equal(getDraft("sync-retry").value, "keep me");

  await sleep(20);
  assert.equal(server.attempts, 2);
  assert.equal(server.state.value, "keep me");
});

test("text typed while a save is in flight goes out in a follow-up save", async () => {
  const server = fakeServer();
  let release;
  server.gate = new Promise((resolve) => {
    release = resolve;
  });
  const sync = new SessionDraftSync("sync-inflight", server.transport, FAST);
  setDraft("sync-inflight", { value: "first", images: [] });

  const pending = sync.refresh();
  await sleep(5);
  setDraft("sync-inflight", { value: "second", images: [] });
  release();
  await pending;
  await sleep(20);

  assert.deepEqual(server.saves, ["first", "second"]);
  assert.equal(server.state.value, "second");
});

test("clearing a shared draft pushes a tombstone so other devices clear too", async () => {
  const server = fakeServer();
  const sync = new SessionDraftSync("sync-clear", server.transport, FAST);
  const composer = storeComposer("sync-clear");
  sync.attach(composer);
  setDraft("sync-clear", { value: "to clear", images: [] });
  await sync.refresh();
  assert.equal(server.state.revision, 1);

  clearDraft("sync-clear");
  await sync.refresh();
  assert.equal(server.state.revision, 2);
  assert.equal(server.state.value, "");
  assert.equal(getDraft("sync-clear")?.value ?? "", "");
  sync.detach(composer);
});

test("with a composer attached, remote drafts go to the composer, not the store", async () => {
  const server = fakeServer({ revision: 5, value: "from elsewhere", images: [PNG] });
  const sync = new SessionDraftSync("sync-composer", server.transport, FAST);
  let local = { value: "", images: [] };
  const applied = [];
  const composer = {
    readDraft: () => local,
    applyRemoteDraft: (draft) => {
      applied.push(draft);
      local = draft;
    },
  };
  sync.attach(composer);
  await sync.refresh();

  assert.deepEqual(applied, [{ value: "from elsewhere", images: [PNG] }]);
  assert.equal(getDraft("sync-composer"), null);
  sync.detach(composer);
});

test("a deleted session stops polling and saving", async () => {
  const server = fakeServer({ revision: 1, value: "first", images: [] });
  const sync = new SessionDraftSync("sync-gone-poll", server.transport, FAST);
  await sync.refresh();

  server.gone = true;
  setDraft("sync-gone-poll", { value: "edit", images: [] });
  await sync.refresh();
  const { polls, attempts } = server;

  sync.kick();
  await sleep(20);
  await sync.refresh();
  assert.equal(server.polls, polls, "no poll after the session is gone");
  assert.equal(server.attempts, attempts, "no save after the session is gone");
  assert.deepEqual(server.saves, []);
});

test("a session deleted during a save stops retrying", async () => {
  const server = fakeServer();
  const sync = new SessionDraftSync("sync-gone-save", server.transport, FAST);
  // Attached, so the held copy stays and the next change is saved rather than polled.
  const composer = storeComposer("sync-gone-save");
  sync.attach(composer);
  await sync.refresh();

  server.gone = true;
  setDraft("sync-gone-save", { value: "edit", images: [] });
  await sync.refresh();
  assert.equal(server.attempts, 1);

  await sleep(20);
  assert.equal(server.attempts, 1, "no retry after the session is gone");
  sync.detach(composer);
});

test("reattaching after an idle eviction adopts a newer server draft without saving", async () => {
  const server = fakeServer({ revision: 1, value: "first", images: [] });
  const sync = new SessionDraftSync("sync-reattach", server.transport, FAST);
  const composer = storeComposer("sync-reattach");
  sync.attach(composer);
  await sync.refresh();
  assert.equal(getDraft("sync-reattach").value, "first");

  // Idle and clean: the held copy is dropped, the store keeps the text.
  sync.detach(composer);
  sync.kick();
  await sleep(20);

  server.state = { revision: 4, value: "newer from phone", images: [] };
  sync.attach(composer);
  await sync.refresh();
  assert.equal(getDraft("sync-reattach").value, "newer from phone");
  assert.equal(server.attempts, 0);
});
