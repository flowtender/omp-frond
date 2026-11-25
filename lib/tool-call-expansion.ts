import { applyPatchResultHasFailures } from "./apply-patch";
import { shellToolDispatches } from "./inline-tool-display";
import { taskToolCards } from "./task-tool-display";
import { isApplyPatchToolName } from "./tool-names";
import type { AssistantContentBlock, ToolCallContent, ToolResultMessage } from "./types";

/** Count failed visible children, or the failed call itself when there are none. */
export function toolCallFailureCount(block: ToolCallContent, result?: ToolResultMessage): number {
  if (!result) return 0;
  const details = result.details;
  const dispatches = shellToolDispatches(details);
  const finalTiming = typeof details === "object" && details !== null
    && "wallTimeMs" in details && typeof details.wallTimeMs === "number";
  let children = 0;
  if (dispatches.length) {
    dispatches.forEach((dispatch, index) => {
      const nested = taskToolCards(dispatch.tool, dispatch.inner, "", result, index)
        .filter((card) => card.status === "failed").length;
      children += nested || Number((finalTiming || result.isError) && dispatch.exitCode !== 0);
    });
  } else {
    children = taskToolCards(block.toolName, details, "", result)
      .filter((card) => card.status === "failed").length;
  }
  return children || Number(result.isError || (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(details)));
}

export function countToolCallFailures(blocks: readonly AssistantContentBlock[], toolResultsMap: Map<string, ToolResultMessage> | undefined): number {
  let count = 0;
  for (const block of blocks) {
    if (block.type === "toolCall") count += toolCallFailureCount(block, toolResultsMap?.get(block.toolCallId));
  }
  return count;
}
export function toolCallExpandedByDefault(mode: string, hasFailure: boolean): boolean {
  return mode === "expanded" || (mode === "failed" && hasFailure);
}


/**
 * Remembers which tool-call cards the user has expanded, keyed by toolCallId.
 *
 * A streaming assistant message is rendered from the streaming store, then re-rendered
 * from `messages` after `message_end`, and moves into Process details when the run
 * ends. Each of those hops remounts `ToolCallBlock`, and so does the session file's
 * read when the message's key cannot pass to its entry (lib/message-keys.ts), as in
 * a run longer than the first page; otherwise the read keeps the card mounted. Plain
 * component state would collapse a card the user just opened. Keeping the set
 * outside React lets the remounted card start expanded without threading state
 * through every message component.
 */
const expandedToolCalls = new Map<string, boolean>();

export function isToolCallExpanded(toolCallId: string | undefined): boolean | undefined {
  return toolCallId === undefined ? undefined : expandedToolCalls.get(toolCallId);
}

export function setToolCallExpanded(toolCallId: string | undefined, expanded: boolean): void {
  if (toolCallId) expandedToolCalls.set(toolCallId, expanded);
}

export function clearExpandedToolCalls(): void {
  expandedToolCalls.clear();
}
