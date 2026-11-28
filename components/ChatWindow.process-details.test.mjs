import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { act, createElement } = await jiti.import("react");
const { createRoot } = await jiti.import("react-dom/client");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ChatTranscript } = await jiti.import("./ChatTranscript.tsx");
const { ProcessDetailsGroup } = await jiti.import("./ProcessDetailsGroup.tsx");
const { StreamingReply } = await jiti.import("./StreamingReply.tsx");
const { buildChatTranscript } = await jiti.import("@/lib/chat-transcript");
const { setExpansionPreference } = await jiti.import("@/lib/expansion-preference");
const { createStreamingStore } = await jiti.import("@/lib/streaming-message");

const user = { role: "user", content: "inspect the project", timestamp: 1000 };
const reply = (text, extra = {}) => ({ role: "assistant", provider: "test", model: "test", stopReason: "stop", content: [{ type: "text", text }], ...extra });
const work = (text) => reply(text, { stopReason: "toolUse", content: [{ type: "text", text }, { type: "toolCall", toolCallId: text, toolName: "read", input: { path: "example.txt" } }] });

function withTranscriptDom(run, { processPreference = "automatic", onlyPinnedRows = false } = {}) {
  const window = new Window({ url: "http://localhost" });
  const { document } = window;
  // No intersections are delivered: only rows pinned by the real renderer mount.
  const IntersectionObserver = onlyPinnedRows ? class {
    observe() {}
    unobserve() {}
  } : undefined;
  const globals = { window, document, navigator: window.navigator, Element: window.Element, Event: window.Event, IntersectionObserver, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = document.createElement("div");
  host.setAttribute("data-chat-transcript-scroll", "");
  document.body.append(host);
  const root = createRoot(host);
  try {
    setExpansionPreference("process", processPreference);
    return run({ host, render(element) { act(() => root.render(createElement(I18nProvider, null, element))); } });
  } finally {
    act(() => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function renderTranscript(messages, { processPreference, onlyPinnedRows, cacheMissMarker = false, sessionEventNotices = {}, ...overrides } = {}) {
  const noticeVisibility = {
    cache_miss: cacheMissMarker, model_usage: false, model_change: false, thinking_level_change: false, service_tier_change: false,
    ...sessionEventNotices,
  };
  return withTranscriptDom(({ host, render }) => {
    render(createElement(ChatTranscript, {
      transcript: buildChatTranscript(messages, {}, noticeVisibility),
      showTokenFlow: overrides.tokenDisplay === "flow",
      messages, entryIds: messages.map((_, idx) => `entry-${idx}`), messageKeys: messages.map((_, idx) => `message-${idx}`),
      toolResultsMap: new Map(), modelNames: {}, messageCwd: "/project", sessionId: "fixture",
      sessionBusy: false, isStreaming: false, isCompacting: false, loading: false, restoringScroll: false,
      visibleReplyStarts: { current: new Set() }, visibleCount: 100, hasEarlierMessages: false, earlierTurnCount: 0,
      hideCost: false, tokenDisplay: "text", noticeVisibility,
      ...overrides,
    }));
    return host.innerHTML;
  }, { processPreference, onlyPinnedRows });
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
    assert.ok(html.includes("first process commentary"));
    assert.ok(html.includes("later process commentary"));
    assert.ok(!html.includes("hidden restart"));
  }
});

test("keeps earlier replies visible while the unfinished tail remains expanded", () => {
  const messages = [user, work("completed process commentary"), reply("completed checkpoint"), work("unfinished process commentary")];
  for (const state of [{}, { sessionBusy: true, isStreaming: true }]) {
    const html = renderTranscript(messages, state);
    assert.ok(html.includes("completed checkpoint"));
    assert.ok(html.includes("completed process commentary"));
    assert.ok(html.includes("unfinished process commentary"));
  }
});

test("preserves partial replies on error, truncation, and interruption", () => {
  for (const stopReason of ["error", "length", "aborted", undefined]) {
    const html = renderTranscript([user, reply("useful partial reply", { stopReason }), work("retry commentary"), reply("recovered reply")]);
    assert.ok(html.includes("useful partial reply"), String(stopReason));
    assert.ok(html.includes("recovered reply"));
    assert.ok(html.includes("retry commentary"));
  }
});

test("chat boxes on both sides of a tool call stay visible in output order", () => {
  const message = work("before tool");
  message.content.push({ type: "text", text: "after tool" });
  const html = renderTranscript([user, message, reply("real reply")]);
  assert.ok(html.indexOf("before tool") < html.indexOf("after tool"));
  assert.ok(html.indexOf("after tool") < html.indexOf("real reply"));
  assert.doesNotMatch(html, /example\.txt/);
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
  assert.ok(html.includes("older process commentary"));
  assert.ok(html.includes("newer process commentary"));
});

test("does not attach one reply's written files to the next reply", () => {
  const write = reply("", { stopReason: "toolUse", content: [{ type: "toolCall", toolCallId: "write", toolName: "write", input: { path: "/project/checkpoint.txt", content: "result" } }] });
  const result = { role: "toolResult", toolCallId: "write", toolName: "write", content: [{ type: "text", text: "wrote file" }] };
  const html = renderTranscript([user, write, result, reply("first reply"), work("later read"), reply("second reply")], { toolResultsMap: new Map([["write", result]]) });
  assert.ok(html.indexOf("checkpoint.txt") > html.indexOf("first reply"));
  assert.ok(html.lastIndexOf("checkpoint.txt") < html.indexOf("second reply"));
});

test("reveals only the searched process segment without hiding either reply", () => {
  const thinking = (text) => reply("", { stopReason: "toolUse", content: [{ type: "thinking", thinking: text }] });
  const html = renderTranscript([user, thinking("matched process commentary"), reply("first reply"), thinking("unmatched process commentary"), reply("second reply")], {
    searchEntryId: "entry-1",
  });
  assert.ok(html.includes("matched process commentary"));
  assert.ok(!html.includes("unmatched process commentary"));
  assert.ok(html.includes("first reply"));
  assert.ok(html.includes("second reply"));
});

test("process preference overrides the automatic default", () => {
  const hidden = reply("", { content: [{ type: "thinking", thinking: "process thinking" }] });
  const messages = [user, hidden, reply("final answer")];
  assert.ok(renderTranscript(messages, { processPreference: "expanded" }).includes("process thinking"));
  assert.ok(!renderTranscript(messages, { processPreference: "collapsed" }).includes("process thinking"));
});

test("leaves unfinished process steps visible with no fold toggles", () => {
  const thought = reply("", { content: [{ type: "thinking", thinking: "unfinished thought" }] });
  const options = { tokenDisplay: "flow", processPreference: "collapsed" };
  const pending = renderTranscript([user, thought], options);
  assert.match(pending, /unfinished thought/);
  assert.doesNotMatch(pending, /token-flow-fold-toggle/);
  const finished = renderTranscript([user, thought, reply("answer")], options);
  assert.doesNotMatch(finished, /unfinished thought/);
  assert.equal((finished.match(/class="token-flow-handoff-icon token-flow-fold-toggle"/g) ?? []).length, 2);
});

test("manual process choice survives an answer and later preference changes", () => {
  withTranscriptDom(({ host, render }) => {
    const renderGroup = (defaultExpanded) => render(createElement(ProcessDetailsGroup, {
      messageCount: 1, toolCallCount: 0, failureCount: 0, defaultExpanded,
      t: (key) => key, renderDetails: () => "process details",
    }));
    const button = () => host.querySelector("button");
    renderGroup(true);
    assert.equal(button().getAttribute("aria-expanded"), "true");
    assert.match(host.textContent, /process details/);
    act(() => button().click());
    renderGroup(false);
    act(() => setExpansionPreference("process", "expanded"));
    assert.equal(button().getAttribute("aria-expanded"), "false");
    assert.doesNotMatch(host.textContent, /process details/);
    act(() => button().click());
    act(() => setExpansionPreference("process", "collapsed"));
    assert.equal(button().getAttribute("aria-expanded"), "true");
    assert.match(host.textContent, /process details/);
  });
});

test("collapsed process header reports failed calls and hides the count when open", () => {
  const messages = [user, work("failed work"), reply("answer")];
  const toolResultsMap = new Map([["failed work", { role: "toolResult", toolCallId: "failed work", isError: true, content: [] }]]);
  assert.ok(renderTranscript(messages, { toolResultsMap }).includes("1 failed"));
  assert.ok(!renderTranscript(messages, { toolResultsMap, processPreference: "expanded" }).includes("1 failed"));
});

test("cache-miss markers show under their step while omp's display.cacheMissMarker is on", () => {
  const marker = (reprocessedTokens) => ({ transcriptNotices: [{ kind: "cache_miss", reprocessedTokens }] });
  const messages = [user, { ...work("step"), ...marker(1500) }, reply("answer", marker(25_400))];

  const folded = renderTranscript(messages, { cacheMissMarker: true });
  assert.match(folded, /cache miss 1\.5K tokens/, "the folded header counts the step's miss, not the answer's");
  assert.equal((folded.match(/Cache miss · 25K tokens/g) ?? []).length, 1);
  assert.doesNotMatch(folded, /Cache miss · 1\.5K tokens/);

  const open = renderTranscript(messages, { cacheMissMarker: true, processPreference: "expanded" });
  assert.doesNotMatch(open, /cache miss 1\.5K tokens/);
  assert.match(open, /Cache miss · 1\.5K tokens/);
  assert.equal((open.match(/Cache miss · 25K tokens/g) ?? []).length, 1);

  const off = renderTranscript(messages, { cacheMissMarker: false, processPreference: "expanded" });
  assert.doesNotMatch(off, /cache miss/i);
});

test("session-event notices show under their message only for the kinds switched on", () => {
  const notices = [
    { kind: "model_change", role: "default", model: "anthropic/claude-a" },
    { kind: "thinking_level_change", level: "high" },
    { kind: "model_usage", purpose: "naming-call", model: "anthropic/claude-b", totalTokens: 1500 },
    { kind: "service_tier_change", serviceTier: {} },
  ];
  const messages = [{ ...user, transcriptNotices: notices }, reply("answer")];

  const off = renderTranscript(messages);
  assert.doesNotMatch(off, /claude-a|Thinking level|naming-call|Service tier/);

  const some = renderTranscript(messages, { sessionEventNotices: { model_change: true, model_usage: true } });
  assert.match(some, /anthropic\/claude-a/);
  assert.match(some, /naming-call/);
  assert.match(some, /1\.5K tokens/);
  assert.doesNotMatch(some, /Thinking level/);
});

test("flow shows one set of counts when a reply's thinking and answer are split", () => {
  const usage = { input: 374, output: 120, cacheRead: 16, cacheWrite: 0, cost: { total: 0.125 } };
  const messages = [user, reply("answer", { usage, content: [{ type: "thinking", thinking: "review" }, { type: "text", text: "answer" }] })];
  const options = { processPreference: "expanded" };
  const flow = renderTranscript(messages, { ...options, tokenDisplay: "flow" });
  assert.equal((flow.match(/New input: 374/g) ?? []).length, 1);
  assert.match(flow, /Cache Read: 16/);
  assert.doesNotMatch(flow, /Cache Write/, "a zero cache write is not drawn");
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
  const result = (toolCallId) => ({ role: "toolResult", toolCallId, content: [{ type: "text", text: "Observed result" }] });
  const messages = [user, batch, steering, result("first"), result("second"), reply("Summary", { usage })];
  const html = renderTranscript(messages, {
    tokenDisplay: "flow", processPreference: "expanded",
  });
  const sequence = Array.from(html.matchAll(/data-token-flow=""|data-token-handoff="([^"]+)"|data-transcript-block="([^"]+)"/g), (match) => match[1] ?? match[2] ?? "model")
    .filter((kind) => kind !== "process" && kind !== "process-end");
  assert.deepEqual(sequence, ["context", "model", "response", "response", "tools", "context", "context", "context", "model", "response", "user"]);
  assert.match(html, /data-token-handoff="process".*data-token-handoff="tools".*data-token-handoff="process-end"/s);
  assert.match(html, /data-token-handoff="tools"[^>]*aria-label="2 tool calls".*?title="read".*?data-tool-icon="read".*?title="grep".*?data-tool-icon="grep"/s);
  const folded = renderTranscript(messages, { tokenDisplay: "flow" });
  assert.match(folded, /inspect both.*Only summarize.*Summary/s);
  assert.doesNotMatch(folded, /Observed result|data-token-handoff="tools"/);
  assert.doesNotMatch(renderTranscript(messages), /data-token-handoff/);
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
    const options = { tokenDisplay: "flow", processPreference: preference };
    const html = renderTranscript(messages, options);
    // A time belongs to the row it sits in; the open process row has none.
    const rows = Array.from(html.matchAll(/data-token-(?:flow=""|handoff="([^"]+)")(?:(?!data-token-)[\s\S])*?class="token-flow-time">([^<]+)/g),
      ([, kind, time]) => [kind ?? "model", time]);
    assert.deepEqual(rows, preference === "expanded"
      ? [["model", localTime(0)], ["compaction", localTime(2)], ["model", localTime(3)], ["user", localTime(4)]]
      : [["model", localTime(0)], ["user", localTime(4)]]);
    assert.ok(html.indexOf("After compaction") < html.indexOf('data-token-handoff="user"'));
    assert.doesNotMatch(renderTranscript(messages, { ...options, sessionBusy: true }), /data-token-handoff="user"/);
  }
});

test("fold totals count every hidden request once, separate from visible requests and unknown usage", () => {
  const usage = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite, cost: { total: 0 } });
  const messages = [user, reply("I’ll check.", { usage: usage(90, 80, 70, 60) }),
    reply("", { stopReason: "toolUse", usage: usage(12, 9, 6, 3), content: [{ type: "thinking", thinking: "hidden reasoning" }] }),
    reply("", { stopReason: "toolUse", content: [] }),
    reply("Found it", { usage: usage(24, 18, 12, 6) })];
  const folded = renderTranscript(messages, { tokenDisplay: "flow" });
  assert.match(folded, /New input: 90/);
  for (const label of ["New input: 36", "Output: 27", "Cache Read: 18", "Cache Write: 9"]) assert.ok(folded.includes(label), label);
  assert.match(folded, /some requests did not report token usage/);
  assert.match(folded, /data-transcript-port="fold"/);
  assert.match(folded, /token-flow-fold-toggle-slot-bottom[^>]*><button[^>]*aria-expanded="false"/);
  assert.doesNotMatch(folded, /New input: 12|New input: 24|hidden reasoning/);
  const expanded = renderTranscript(messages, { tokenDisplay: "flow", processPreference: "expanded" });
  assert.doesNotMatch(expanded, /New input: 36/);
  assert.doesNotMatch(expanded, /data-transcript-port="fold"/);
  assert.match(expanded, /New input: 12.*New input: Not reported.*New input: 24/s);
  assert.doesNotMatch(renderTranscript(messages, { tokenDisplay: "off" }), /New input:|transcript-fold-totals/);
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
    ...options, searchEntryId: "entry-7", searchBlock: messages[7].content[1],
  });
  assert.match(jumped, /data-search-target="true"[^>]*>[\s\S]*?Answer 3</);
  assert.match(jumped, /Answer 23</);
});

test("renders one model row while awaiting the first assistant snapshot", () => {
  withTranscriptDom(({ host, render }) => {
    const store = createStreamingStore();
    const renderReply = (waitingForModel) => render(createElement(StreamingReply, {
      store, onCommit: () => {}, toolResults: new Map(),
      model: { provider: "test", modelId: "pending-model" }, modelNames: {}, tokenDisplay: "flow", waitingForModel,
    }));
    renderReply(false);
    assert.equal(host.innerHTML, "");
    renderReply(true);
    assert.match(host.innerHTML, /Token display: test\/pending-model/);
    assert.match(host.innerHTML, /New input: Not reported/);
    act(() => store.dispatch({ type: "snapshot", message: reply("first chunk", { model: "serving-model" }) }));
    assert.match(host.innerHTML, /Token display: test\/serving-model/);
    assert.match(host.textContent, /first chunk/);
    assert.equal(host.querySelectorAll("[data-token-flow]").length, 1);
  });
});
