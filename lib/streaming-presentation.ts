import type { AssistantContentBlock, AssistantMessage } from "./types";

function streamingText(block: AssistantContentBlock | undefined): string | undefined {
  switch (block?.type) {
    case "text": return block.text;
    case "thinking": return block.thinking;
    case "toolCall": return block.rawInput;
  }
}

/** Pace only the growing tail; completed blocks and replacements stay authoritative. */
export function revealStreamingMessage(
  shown: AssistantMessage | null,
  latest: AssistantMessage | null,
  fraction: number,
): AssistantMessage | null {
  if (!shown || !latest || fraction >= 1 || shown === latest
    || shown.timestamp !== latest.timestamp || shown.provider !== latest.provider || shown.model !== latest.model) {
    return latest;
  }

  const index = latest.content.length - 1;
  const block = latest.content[index];
  if (block?.type !== "text" && block?.type !== "thinking" && block?.type !== "toolCall") return latest;
  const text = streamingText(block);
  if (!text || shown.content.length > latest.content.length) return latest;

  const previousBlock = shown.content[index];
  if (previousBlock && (previousBlock.type !== block.type
    || (block.type === "toolCall" && previousBlock.type === "toolCall"
      && previousBlock.toolCallId && block.toolCallId && previousBlock.toolCallId !== block.toolCallId))) {
    return latest;
  }
  const previous = previousBlock ? streamingText(previousBlock) : "";
  if (previous === undefined || !text.startsWith(previous)) return latest;

  let end = previous.length + Math.ceil((text.length - previous.length) * fraction);
  // Don't add a broken surrogate pair at a presentation-only boundary.
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end++;
  if (end >= text.length) return latest;

  const prefix = text.slice(0, end);
  const content = latest.content.slice();
  content[index] = block.type === "text" ? { ...block, text: prefix }
    : block.type === "thinking" ? { ...block, thinking: prefix }
    : { ...block, rawInput: prefix };
  return { ...latest, content };
}
