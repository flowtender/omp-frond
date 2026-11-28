import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");


test("reuses an open event stream and hides an empty agent phase", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureEventsConnected"),
    source.indexOf("const respondToExtensionUi"),
  );

  assert.match(ensureSource, /eventSourceSessionIdRef\.current === sid/);
  assert.match(ensureSource, /current\.readyState === EventSource\.OPEN/);
  assert.match(chatWindowSource, /agentRunning && !hasStreamingContent && \(agentPhase \|\| isCompacting\)/);
  assert.match(chatWindowSource, /return null;/);
});

test("plays the enabled sound when an extension dialog surfaces", () => {
  // Upstream semantics: one chime when a dialog appears with none on screen;
  // one queued behind another stays quiet until it surfaces.
  assert.match(chatWindowSource, /extensionDialogShownRef = useRef\(false\)/);
  assert.match(
    chatWindowSource,
    /const surfaced = Boolean\(extensionDialog\) && !extensionDialogShownRef\.current/,
  );
  assert.match(chatWindowSource, /playDoneSoundRef\.current\(\)/);
});

test("keeps completed subagents in the session history", () => {
  assert.match(source, /function mergeSubagentSnapshots/);
  assert.match(source, /const finished: SubagentSnapshot/);
  assert.match(source, /progress: previous\?\.progress \? \{ \.\.\.previous\.progress, status: terminalStatus \}/);
  assert.doesNotMatch(source, /payload\.status !== "started"\) \{\s*setSubagents\(\(previous\) => previous\.filter/);
});

test("routes blocking extension requests through deduplicated browser attention notifications", () => {
  const completionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  const extensionRequestSource = source.slice(
    source.indexOf("  const handleExtensionUiRequest = useCallback"),
    source.indexOf("  const settleUiStage = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(
    extensionRequestSource,
    /isBlockingExtensionUiRequest\(request\)[\s\S]*?onAttentionNeeded\?\.\(request\)/,
  );
  assert.match(chatWindowSource, /onAttentionNeeded, onSessionCreated/);
  assert.match(completionSource, /if \(!shouldShowBrowserNotification\(\)\) return/);
  assert.match(attentionSource, /shouldShowBrowserNotification\(\)/);
  assert.match(attentionSource, /claimExtensionAttentionNotification\(request, notifiedAttentionRequestIdsRef\.current\)/);
  assert.match(attentionSource, /tag: `pi-extension-ui:\$\{request\.id\}`/);
  assert.match(appShellSource, /onAttentionNeeded=\{handleAttentionNeeded\}/);
});


test("/fork is consumed locally and surfaces server resolution errors", () => {
  const forkCaseSource = source.slice(
    source.indexOf('case "fork":'),
    source.indexOf('case "goal":', source.indexOf('case "fork":')),
  );

  assert.match(source, /case "fork": \{/);
  assert.match(forkCaseSource, /const result = await handleFork\(\);/);
  assert.doesNotMatch(forkCaseSource, /messages|entryIds|newestUserEntryId/);
  assert.match(forkCaseSource, /complete\(\{ handled: true, error: result\.error \?\? "Fork failed" \}\)/);
  assert.match(forkCaseSource, /complete\(\{ handled: true, message: "Forked a new session" \}\)/);
  // Every branch returns handled, so /fork never reaches the SDK fallback that
  // forwards the message as an LLM prompt — the case ends in a handled return
  // and yields to the next explicit case, not the default bridge.
  assert.doesNotMatch(forkCaseSource, /execute_slash_command/);
  assert.doesNotMatch(forkCaseSource, /type: "prompt"/);
  assert.match(source, /case "fork":[\s\S]*?return complete\(\{ handled: true, message: "Forked a new session" \}\);\s*\}\s*case "goal": \{/);
});

test("fork navigation selects the new session id from the RPC result", () => {
  const forkSource = source.slice(
    source.indexOf("const handleFork = useCallback"),
    source.indexOf("const handleNavigate = useCallback"),
  );

  assert.match(forkSource, /const handleFork = useCallback\(async \([\s\S]*?entryId\?: string,[\s\S]*?Promise<\{ forked: boolean; error\?: string \}>/);
  assert.match(forkSource, /type: "fork"/);
  assert.match(forkSource, /\.\.\.\(entryId \? \{ entryId \} : \{\}\)/);
  assert.match(forkSource, /const \{ cancelled, newSessionId \} = result \?\? \{\};/);
  assert.match(forkSource, /if \(!cancelled && newSessionId\) \{/);
  assert.match(forkSource, /onSessionForked\?\.\(newSessionId\);\s*\n\s*return \{ forked: true \};/);
  assert.match(forkSource, /error: e instanceof Error \? e\.message : String\(e\)/);
  assert.match(forkSource, /setForkingEntryId\(null\)/);
});

test("/compact handoff keeps the UI busy and forwards the focus through the compact command", () => {
  const handoffSource = source.slice(
    source.indexOf("const runHandoff = useCallback"),
    source.indexOf("const handleCompact = useCallback"),
  );

  // The long oneshot generation keeps the composer busy through existing
  // agent-running state, with no new state machine.
  assert.match(handoffSource, /if \(agentRunningRef\.current \|\| bashRunningRef\.current\)/);
  assert.match(handoffSource, /Cannot hand off while the session is busy/);
  assert.match(handoffSource, /agentRunningRef\.current = true/);
  assert.match(handoffSource, /setAgentRunning\(true\)/);
  assert.match(handoffSource, /agentRunningRef\.current = false/);
  assert.match(handoffSource, /setAgentRunning\(false\)/);
  assert.match(handoffSource, /compactCommand\(\{ mode: "handoff", focus \}\)/);
  assert.match(handoffSource, /if \(!result \|\| result\.cancelled\) return \{ error: "Handoff cancelled" \}/);
  const connectIndex = handoffSource.indexOf("await ensureEventsConnected(sessionIdRef.current ?? sid)");
  const dispatchIndex = handoffSource.indexOf("compactCommand(");
  assert.ok(connectIndex >= 0);
  assert.ok(dispatchIndex > connectIndex);
  assert.match(handoffSource, /scheduleEventStreamClose\(finalSid\)/);
  // omp hands off in place: the session id never changes, so success reloads
  // this transcript instead of navigating to a replacement session.
  assert.doesNotMatch(handoffSource, /newSessionId/);
  assert.doesNotMatch(handoffSource, /onSessionForked/);
  assert.match(handoffSource, /loadSession\(sessionIdRef\.current \?\? currentSid, true\)/);
});

test("/compact parses a mode prefix and routes handoff to the busy-locking path", () => {
  const compactCaseSource = source.slice(
    source.indexOf('case "compact": {'),
    source.indexOf('case "reload": {'),
  );
  assert.match(compactCaseSource, /splitCompactArgs\(args\)/);
  assert.match(compactCaseSource, /request\.mode === "handoff"\) return complete\(\{ handled: true, \.\.\.await runHandoff\(sid, request\.focus\) \}\)/);
  assert.match(compactCaseSource, /compactCommand\(request\)/);
  // /handoff is gone from the composer: it is a mode of /compact.
  assert.doesNotMatch(source, /case "handoff":/);
});

test("rehydrates handoff as busy without misreporting compaction", () => {
  assert.match(source, /isHandoffRunning\?: boolean/);
  assert.match(
    source,
    /state\.isStreaming \|\| state\.isPromptRunning \|\| state\.isCompacting \|\| state\.isHandoffRunning/,
  );
  assert.match(
    source,
    /agentState\.state\?\.isStreaming[\s\S]*?agentState\.state\?\.isPromptRunning[\s\S]*?agentState\.state\?\.isHandoffRunning/,
  );
});

test("exposes a paused-follow flag and a jump-to-bottom action", () => {
  // The ref drives the scroll effects and the state drives the button; one
  // writer keeps them from drifting apart.
  assert.match(source, /const setAutoFollow = useCallback\(\(following: boolean\) => \{\s*completionScrollAllowedRef\.current = following;\s*setAutoFollowPaused\(/);
  assert.match(source, /const resumeAutoFollow = useCallback\(\(\) => \{[\s\S]*?userScrollIntentUntilRef\.current = 0;[\s\S]*?setAutoFollow\(true\);[\s\S]*?scrollToBottom\("smooth"\)/);
  assert.match(source, /autoFollowPaused, resumeAutoFollow,/);
  // A new prompt or shell command resumes following.
  assert.doesNotMatch(source, /completionScrollAllowedRef\.current = true;/);

  assert.match(chatWindowSource, /resumeAutoFollow,/);
  assert.match(chatWindowSource, /showScrollToBottom && !pendingScrollRestore/);
  assert.match(chatWindowSource, /onClick=\{resumeAutoFollow\}/);
});

test("renders the transcript with omp's hideThinkingBlock setting", () => {
  const messageViewSource = readFileSync(new URL("../components/MessageView.tsx", import.meta.url), "utf8");
  assert.match(messageViewSource, /const \{ hideThinkingBlock \} = useDisplaySettings\(\)/);
  assert.match(messageViewSource, /isHiddenAssistantBlock\(block, \{ isStreaming, hideThinking: hideThinkingBlock \}\)/);

  assert.match(chatWindowSource, /useSyncedDisplaySettings\(/);
  assert.match(chatWindowSource, /displayOptions = useMemo<DisplayOptions>\(\(\) => \(\{ hideThinking: hideThinkingBlock \}\)/);
  // Turn grouping has to agree with what MessageView renders, or a message
  // made only of thinking blocks leaves an empty row behind.
  assert.match(chatWindowSource, /getDisplayableAssistantBlocks\(message, displayOptions\)/);
  assert.match(chatWindowSource, /findFinalAssistantIndex\(messages, userIdx, endIdx, displayOptions\)/);
});
