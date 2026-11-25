import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { MessageView } = await jiti.import("./MessageView.tsx");
const display = await import("../lib/message-display.ts");
const views = await import("../lib/turn-views.ts");
const duration = await import("../lib/turn-duration.ts");
const notices = await import("../lib/transcript-notices.ts");
const noticeViews = await jiti.import("./TranscriptNotices.tsx");
const { extractTurnWrittenFiles } = await import("../lib/turn-written-files.ts");
const paging = await import("../lib/chat-lazy-load.ts");
const { countToolCallFailures } = await jiti.import("@/lib/tool-call-expansion");

// Exercise the real transcript renderer without mounting the session/network hooks.
const source = ts.createSourceFile("ChatWindow.tsx", await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
const renderer = nodes.find((node) => ts.isArrowFunction(node) && ts.isBlock(node.body)
  && node.body.statements.length > 0
  && ts.isVariableStatement(node.body.statements[0])
  && node.body.statements[0].declarationList.declarations[0].name.getText(source) === "lastUserIdx");
assert.ok(renderer);
const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node)
  && ["hasFinalAssistantAnswer", "findFinalAssistantIndex", "ProcessDetailsGroup"].includes(node.name?.text));
const script = new Script(ts.transpileModule(
  `${functions.map((node) => node.getText(source)).join("\n")}\n(${renderer.getText(source)})`,
  { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } },
).outputText);

const user = { role: "user", content: "inspect the project", timestamp: 1000 };
const reply = (text, extra = {}) => ({ role: "assistant", provider: "test", model: "test", stopReason: "stop", content: [{ type: "text", text }], ...extra });
const work = (text) => reply(text, { stopReason: "toolUse", content: [{ type: "text", text }, { type: "toolCall", toolCallId: text, toolName: "read", input: { path: "example.txt" } }] });

function renderTranscript(messages, overrides = {}) {
  const context = createContext({
    React, Fragment: React.Fragment, useState: React.useState, useLayoutEffect: React.useLayoutEffect,
    ...display, ...views, ...duration, ...notices, ...noticeViews, ...paging, extractTurnWrittenFiles, countToolCallFailures,
    useExpansionPreference: () => "automatic",
    MessageView, messages, entryIds: messages.map((_, idx) => `entry-${idx}`), messageKeys: messages.map((_, idx) => `message-${idx}`),
    displayOptions: {}, finalAnswerViewCache: new WeakMap(), toolResultsMap: new Map(), modelNames: {}, messageCwd: "/project",
    sessionBusy: false, isStreaming: false, bashRunning: false, isNew: false, isCompacting: false, compactError: null,
    lastUserMsgRef: { current: null }, pendingSearchScroll: null, searchBlock: null, forkingEntryId: null, editEntryId: null,
    session: { id: "fixture" }, sessionIdRef: { current: "fixture" }, visibleCount: 100, hasEarlierMessages: false, earlierTurnCount: 0,
    handleFork: undefined, handleEditContent: undefined, cancelEdit: undefined, handleOpenFile: undefined,
    onOpenFile: undefined, onOpenSubagent: undefined, handleCompact: undefined, setSentinel: undefined, setVisibleCount: undefined,
    hideCost: false, t: (key) => key,
    ...overrides,
  });
  const Transcript = script.runInContext(context);
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Transcript)));
}

test("preserves every completed reply across autonomous continuations", () => {
  for (const continuation of [
    [],
    [{ role: "custom", customType: "advisor", display: true, content: "check again" }],
    [{ role: "custom", customType: "irc:incoming", display: true, content: "peer feedback" }],
    [{ role: "custom", customType: "session-stop-continuation", display: false, content: "hidden restart" }],
    [{ role: "custom", customType: "extension-defined", display: true, content: "extension feedback" }],
  ]) {
    const html = renderTranscript([user, work("first process commentary"), reply("first completed reply"), ...continuation, work("later process commentary"), reply("later completed reply")]);
    assert.ok(html.includes("first completed reply"), JSON.stringify(continuation));
    assert.ok(html.includes("later completed reply"));
    assert.ok(html.indexOf("first completed reply") < html.indexOf("later completed reply"));
    assert.ok(!html.includes("first process commentary"));
    assert.ok(!html.includes("later process commentary"));
    assert.ok(!html.includes("hidden restart"));
  }
});

test("keeps earlier replies visible while the unfinished tail remains expanded", () => {
  const messages = [user, work("completed process commentary"), reply("completed checkpoint"), work("unfinished process commentary")];
  for (const state of [{}, { sessionBusy: true, isStreaming: true }]) {
    const html = renderTranscript(messages, state);
    assert.ok(html.includes("completed checkpoint"));
    assert.ok(!html.includes("completed process commentary"));
    assert.ok(html.includes("unfinished process commentary"));
  }
});

test("preserves partial replies on error, truncation, and interruption", () => {
  for (const stopReason of ["error", "length", "aborted", undefined]) {
    const html = renderTranscript([user, reply("useful partial reply", { stopReason }), work("retry commentary"), reply("recovered reply")]);
    assert.ok(html.includes("useful partial reply"), String(stopReason));
    assert.ok(html.includes("recovered reply"));
    assert.ok(!html.includes("retry commentary"));
  }
});

test("keeps tool commentary folded rather than treating it as a completed reply", () => {
  const html = renderTranscript([user, reply("tool commentary", { stopReason: "toolUse" }), work("more tool commentary"), reply("real reply")]);
  assert.ok(!html.includes("tool commentary"));
  assert.ok(html.includes("real reply"));
});

test("expands unanswered process details and retains an earlier reply before an empty error", () => {
  const html = renderTranscript([user, reply("earlier reply"), work("unfinished commentary"), reply("", { stopReason: "error", errorMessage: "provider unavailable" })]);
  assert.ok(html.includes("earlier reply"));
  assert.ok(html.includes("unfinished commentary"));
  assert.ok(html.includes("provider unavailable"));
});

test("preserves replies in a history page that starts midway through work", () => {
  const html = renderTranscript([work("older process commentary"), reply("older reply"), work("newer process commentary"), reply("newer reply")]);
  assert.ok(html.includes("older reply"));
  assert.ok(html.includes("newer reply"));
  assert.ok(!html.includes("older process commentary"));
  assert.ok(!html.includes("newer process commentary"));
});

test("does not attach one reply's written files to the next reply", () => {
  const write = reply("", { stopReason: "toolUse", content: [{ type: "toolCall", toolCallId: "write", toolName: "write", input: { path: "/project/checkpoint.txt", content: "result" } }] });
  const result = { role: "toolResult", toolCallId: "write", toolName: "write", content: [{ type: "text", text: "wrote file" }] };
  const html = renderTranscript([user, write, result, reply("first reply"), work("later read"), reply("second reply")], { toolResultsMap: new Map([["write", result]]) });
  assert.ok(html.indexOf("checkpoint.txt") > html.indexOf("first reply"));
  assert.ok(html.lastIndexOf("checkpoint.txt") < html.indexOf("second reply"));
});

test("reveals only the searched process segment without hiding either reply", () => {
  const html = renderTranscript([user, work("matched process commentary"), reply("first reply"), work("unmatched process commentary"), reply("second reply")], {
    pendingSearchScroll: { entryId: "entry-1" },
  });
  assert.ok(html.includes("matched process commentary"));
  assert.ok(!html.includes("unmatched process commentary"));
  assert.ok(html.includes("first reply"));
  assert.ok(html.includes("second reply"));
});

test("process preference overrides the automatic default", () => {
  const messages = [user, work("process commentary"), reply("final answer")];
  assert.ok(renderTranscript(messages, { useExpansionPreference: () => "expanded" }).includes("process commentary"));
  assert.ok(!renderTranscript([user, work("unfinished")], { useExpansionPreference: () => "collapsed" }).includes("unfinished"));
});

test("manual process choice survives an answer and later preference changes", () => {
  const group = functions.find((node) => node.name.text === "ProcessDetailsGroup");
  let state = null;
  let preference = "automatic";
  const context = createContext({
    React,
    useState: () => [state, (value) => { state = value; }],
    useLayoutEffect: () => {},
    useExpansionPreference: () => preference,
    formatTurnDuration: duration.formatTurnDuration,
    cacheMissSummaryText: noticeViews.cacheMissSummaryText,
    TRANSCRIPT_NOTICE_WARNING_COLOR: noticeViews.TRANSCRIPT_NOTICE_WARNING_COLOR,
  });
  const component = new Script(ts.transpileModule(`(${group.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React },
  }).outputText).runInContext(context);
  const props = { messageCount: 1, toolCallCount: 0, failureCount: 0, t: (key) => key, children: "work" };
  const button = (defaultExpanded) => component({ ...props, defaultExpanded }).props.children[0];
  assert.equal(button(true).props["aria-expanded"], true);
  button(true).props.onClick();
  assert.equal(button(false).props["aria-expanded"], false);
  preference = "expanded";
  assert.equal(button(false).props["aria-expanded"], false);
  button(false).props.onClick();
  preference = "collapsed";
  assert.equal(button(false).props["aria-expanded"], true);
});

test("collapsed process header reports failed calls and hides the count when open", () => {
  const messages = [user, work("failed work"), reply("answer")];
  const toolResultsMap = new Map([["failed work", { role: "toolResult", toolCallId: "failed work", isError: true, content: [] }]]);
  const t = (key, params) => key === "chat.processFailures" ? `${params.count} failures` : key;
  assert.ok(renderTranscript(messages, { toolResultsMap, t }).includes("1 failures"));
  assert.ok(!renderTranscript(messages, { toolResultsMap, t, useExpansionPreference: () => "expanded" }).includes("1 failures"));
});
