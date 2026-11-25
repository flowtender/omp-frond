import assert from "node:assert/strict";
import test from "node:test";
import {
  getExpansionPreference,
  setExpansionPreference,
  subscribeExpansionPreference,
} from "./expansion-preference.ts";

function installWindow() {
  const store = new Map();
  const target = new EventTarget();
  const fakeWindow = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  globalThis.window = fakeWindow;
  return { fakeWindow, store };
}

test("defaults and legacy thinking preference", () => {
  const { store } = installWindow();
  assert.equal(getExpansionPreference("thinking"), "collapsed");
  assert.equal(getExpansionPreference("tools"), "collapsed");
  assert.equal(getExpansionPreference("process"), "automatic");
  assert.equal(getExpansionPreference("compaction"), "collapsed");
  store.set("pi-thinking-expanded", "true");
  assert.equal(getExpansionPreference("thinking"), "expanded");
  store.set("pi-thinking-expanded", "false");
  assert.equal(getExpansionPreference("thinking"), "collapsed");
  store.set("pi-thinking-expanded", "true");
  setExpansionPreference("thinking", "collapsed");
  assert.equal(getExpansionPreference("thinking"), "collapsed", "new selection overrides legacy preference");
});

test("persists independent modes and notifies subscribers in this and other tabs", () => {
  const { fakeWindow } = installWindow();
  let notifications = 0;
  const unsubscribe = subscribeExpansionPreference(() => notifications++);
  setExpansionPreference("tools", "failed");
  setExpansionPreference("process", "expanded");
  setExpansionPreference("compaction", "expanded");
  assert.equal(getExpansionPreference("tools"), "failed");
  assert.equal(getExpansionPreference("process"), "expanded");
  assert.equal(getExpansionPreference("compaction"), "expanded");
  assert.equal(notifications, 3);
  fakeWindow.dispatchEvent(new Event("storage"));
  assert.equal(notifications, 4);
  unsubscribe();
  setExpansionPreference("tools", "collapsed");
  fakeWindow.dispatchEvent(new Event("storage"));
  assert.equal(notifications, 4);
});

test("rejects invalid modes and stored values", () => {
  const { store } = installWindow();
  store.set("pi-expansion-thinking", "failed");
  store.set("pi-expansion-tools", "automatic");
  store.set("pi-expansion-process", "failed");
  assert.equal(getExpansionPreference("thinking"), "collapsed");
  assert.equal(getExpansionPreference("tools"), "collapsed");
  assert.equal(getExpansionPreference("process"), "automatic");
  setExpansionPreference("compaction", "failed");
  assert.equal(store.has("pi-expansion-compaction"), false);
});

test("storage failures and server rendering use defaults without notifying", () => {
  const { fakeWindow } = installWindow();
  let notifications = 0;
  const unsubscribe = subscribeExpansionPreference(() => notifications++);
  Object.defineProperty(fakeWindow, "localStorage", {
    get() { throw new DOMException("blocked", "SecurityError"); },
  });
  assert.equal(getExpansionPreference("thinking"), "collapsed");
  assert.equal(getExpansionPreference("process"), "automatic");
  assert.doesNotThrow(() => setExpansionPreference("thinking", "expanded"));
  assert.equal(notifications, 0);
  unsubscribe();
  delete globalThis.window;
  assert.equal(getExpansionPreference("thinking"), "collapsed");
  assert.equal(getExpansionPreference("process"), "automatic");
  assert.doesNotThrow(() => setExpansionPreference("thinking", "expanded"));
});
