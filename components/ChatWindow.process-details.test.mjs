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
const { getModelDisplayName, handoffTimeOf, MessageView } = await jiti.import("./MessageView.tsx");
const { TranscriptBlock } = await jiti.import("./TranscriptBlock.tsx");
const { TokenFlow, TokenFlowHandoff } = await jiti.import("./TokenFlow.tsx");
const { useI18n } = await jiti.import("@/hooks/useI18n");
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
    TranscriptBlock,
    TokenFlowHandoff,
    handoffTimeOf,
    TranscriptViewportRow: ({ render, pinned }) => !overrides.onlyPinnedRows || pinned ? render() : null,
    MessageView, messages, entryIds: messages.map((_, idx) => `entry-${idx}`), messageKeys: messages.map((_, idx) => `message-${idx}`),
    displayOptions: {}, finalAnswerViewCache: new WeakMap(), toolResultsMap: new Map(), modelNames: {}, messageCwd: "/project",
    sessionBusy: false, isStreaming: false, bashRunning: false, isNew: false, isCompacting: false, compactError: null,
    lastUserMsgRef: { current: null }, pendingSearchScroll: null, searchBlock: null, forkingEntryId: null, editEntryId: null,
    pendingScrollRestore: null,
    session: { id: "fixture" }, sessionIdRef: { current: "fixture" }, visibleCount: 100, hasEarlierMessages: false, earlierTurnCount: 0,
    handleFork: undefined, handleEditContent: undefined, cancelEdit: undefined, handleOpenFile: undefined,
    onOpenFile: undefined, onOpenSubagent: undefined, handleCompact: undefined, setSentinel: undefined, setVisibleCount: undefined,
    hideCost: false, t: (key) => key,
    tokenDisplay: "text",
    cacheMissMarker: false,
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
    TranscriptBlock,
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

test("cache-miss markers show under their step while omp's display.cacheMissMarker is on", () => {
  const marker = (reprocessedTokens) => ({ transcriptNotices: [{ kind: "cache_miss", reprocessedTokens }] });
  const messages = [user, { ...work("step"), ...marker(1500) }, reply("answer", marker(25_400))];
  const t = (key, params) => key.startsWith("transcriptNotice.fold") ? `${params.count} misses ${params.tokens}` : key;

  const folded = renderTranscript(messages, { t, cacheMissMarker: true });
  assert.match(folded, /1 misses 1\.5K/, "the folded header counts the step's miss, not the answer's");
  assert.equal((folded.match(/Cache miss · 25K tokens/g) ?? []).length, 1);
  assert.doesNotMatch(folded, /Cache miss · 1\.5K tokens/);

  const open = renderTranscript(messages, { t, cacheMissMarker: true, useExpansionPreference: () => "expanded" });
  assert.doesNotMatch(open, /1 misses/);
  assert.match(open, /Cache miss · 1\.5K tokens/);
  assert.equal((open.match(/Cache miss · 25K tokens/g) ?? []).length, 1);

  const off = renderTranscript(messages, { t, cacheMissMarker: false, useExpansionPreference: () => "expanded" });
  assert.doesNotMatch(off, /Cache miss|misses/);
});

test("flow shows one set of counts when a reply's thinking and answer are split", () => {
  const usage = { input: 374, output: 120, cacheRead: 16, cacheWrite: 0, cost: { total: 0.125 } };
  const messages = [user, reply("answer", { usage, content: [{ type: "thinking", thinking: "review" }, { type: "text", text: "answer" }] })];
  const options = { useExpansionPreference: () => "expanded" };
  const flow = renderTranscript(messages, { ...options, tokenDisplay: "flow" });
  assert.equal((flow.match(/New input: 374/g) ?? []).length, 1);
  assert.match(flow, /Cache Read: 16/);
  assert.match(flow, /Cache Write: 0 · A zero can mean/);
  const withWrites = [{ ...messages[1], usage: { ...usage, cacheWrite: 52 } }];
  assert.ok(flow.indexOf("New input: 374") < flow.indexOf("review"));
  assert.equal((flow.match(/data-transcript-block="response"/g) ?? []).length, 2);
  const folded = renderTranscript(messages, { tokenDisplay: "flow" });
  assert.equal((folded.match(/New input: 374/g) ?? []).length, 1);
  assert.equal((folded.match(/data-transcript-block="response"/g) ?? []).length, 1);
  assert.doesNotMatch(folded, /review/);
  assert.match(renderTranscript([user, ...withWrites], { ...options, tokenDisplay: "flow" }), /title="Cache Write: 52"/);
  assert.doesNotMatch(flow, /374 in/);
  assert.match(renderTranscript(messages, options), /374 in · 120 out · 16 cache R/);
  const off = renderTranscript(messages, { ...options, tokenDisplay: "off" });
  assert.doesNotMatch(off, /374 in|New input: 374/);
  assert.match(off, /\$0\.1250/);
});

test("tool results and appended steering are input boxes, not model output", () => {
  const usage = { input: 40, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
  const call = (toolCallId, toolName) => ({ type: "toolCall", toolCallId, toolName, input: { path: `${toolCallId}.txt`, pattern: "match" } });
  const batch = reply("", {
    stopReason: "toolUse", usage, content: [
      { type: "thinking", thinking: "Check both files" },
      { type: "text", text: "I’ll inspect both." },
      call("first", "read"),
      call("second", "grep"),
    ],
  });
  const steering = { role: "user", content: "Only summarize.", attribution: "user" };
  const html = renderTranscript([user, batch, steering, reply("Summary", { usage })], {
    tokenDisplay: "flow", useExpansionPreference: () => "expanded",
  });
  const sequence = Array.from(html.matchAll(/data-token-flow=""|data-token-handoff="([^"]+)"|data-transcript-block="([^"]+)"/g), (match) => match[1] ?? match[2] ?? "model");
  assert.deepEqual(sequence, ["context", "process", "model", "response", "response", "tools", "context", "context", "context", "model", "response", "user"]);
  assert.match(html, /data-token-handoff="tools"[^>]*aria-label="2 tool calls".*?title="read".*?data-tool-icon="read".*?title="grep".*?data-tool-icon="grep"/s);
  assert.doesNotMatch(renderTranscript([user, batch, steering, reply("Summary", { usage })]), /data-token-handoff/);
});

test("shows the request, compaction and user handoff times without a false user handoff before compaction", () => {
  const usage = { input: 40, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
  const started = new Date();
  started.setHours(12, 0, 0, 0);
  const stamp = (minutes) => started.getTime() + minutes * 60_000;
  const localTime = (minutes) => new Date(stamp(minutes)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const messages = [
    user,
    reply("Before compaction", { usage, timestamp: stamp(0), durationMs: 60_000 }),
    { role: "custom", customType: "compaction", display: true, content: "Earlier context", timestamp: stamp(2) },
    reply("After compaction", { usage, timestamp: stamp(3), durationMs: 60_000, content: [
      { type: "thinking", thinking: "review" }, { type: "text", text: "After compaction" },
    ] }),
  ];
  for (const preference of ["expanded", "collapsed"]) {
    const options = { tokenDisplay: "flow", useExpansionPreference: () => preference };
    const html = renderTranscript(messages, options);
    const rows = Array.from(html.matchAll(/data-token-(?:flow=""|handoff="([^"]+)")[\s\S]*?class="token-flow-time">([^<]+)/g),
      ([, kind, time]) => [kind ?? "model", time]);
    assert.deepEqual(rows, [["model", localTime(0)], ["compaction", localTime(2)], ["process", localTime(4)], ["model", localTime(3)], ["user", localTime(4)]]);
    assert.ok(html.indexOf("After compaction") < html.indexOf('data-token-handoff="user"'));
    assert.doesNotMatch(renderTranscript(messages, { ...options, sessionBusy: true }), /data-token-handoff="user"/);
  }
});

test("mounts the entire split reply for a search hit outside the viewport", () => {
  const messages = Array.from({ length: 24 }, (_, index) => [
    { ...user, content: `Question ${index}` },
    reply(`Answer ${index}`, {
      usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      content: [{ type: "thinking", thinking: `Reasoning ${index}` }, { type: "text", text: `Answer ${index}` }],
    }),
  ]).flat();
  const options = { tokenDisplay: "flow", onlyPinnedRows: true };
  assert.doesNotMatch(renderTranscript(messages, options), /Answer 3</);
  const jumped = renderTranscript(messages, {
    ...options, pendingSearchScroll: { entryId: "entry-7" }, searchBlock: messages[7].content[1],
  });
  assert.match(jumped, /data-search-target="true"[^>]*>[\s\S]*?Answer 3</);
  assert.match(jumped, /Answer 23</);
});

test("renders one model row while awaiting the first assistant snapshot", () => {
  const component = nodes.find((node) => ts.isFunctionExpression(node) && node.name?.text === "StreamingReply");
  const code = ts.transpileModule(`(${component.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React },
  }).outputText;
  let snapshot = null;
  const StreamingReply = new Script(code).runInContext(createContext({
    React, useLayoutEffect: React.useLayoutEffect, useStreamingSelector: () => snapshot,
    selectStreamingMessage: () => snapshot, useI18n, getModelDisplayName, MessageView, TokenFlow,
  }));
  const render = (waitingForModel) => renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(StreamingReply, {
      model: { provider: "test", modelId: "pending-model" }, modelNames: {}, tokenDisplay: "flow", waitingForModel,
    }),
  ));
  assert.equal(render(false), "");
  const pending = render(true);
  assert.match(pending, /Token display: test\/pending-model/);
  assert.match(pending, /New input: Not reported/);
  snapshot = reply("first chunk", { model: "serving-model" });
  const streaming = render(false);
  assert.match(streaming, /Token display: test\/serving-model/);
  assert.match(streaming, /first chunk/);
  assert.equal((streaming.match(/data-token-flow=/g) ?? []).length, 1);
});
