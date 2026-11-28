import { memo, useLayoutEffect, useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useSequencedReply } from "@/hooks/useSequencedReply";
import type { TokenDisplayMode } from "@/hooks/useTokenDisplay";
import type { StreamingStore } from "@/lib/streaming-message";
import type { AssistantMessage, ToolResultMessage } from "@/lib/types";
import { MessageView } from "./MessageView";

// The reply being streamed: the one part of the chat a chunk re-renders.
export const StreamingReply = memo(function StreamingReply({ store, onCommit, toolResults, modelNames, cwd, onOpenFile, onOpenSubagent, tokenDisplay, waitingForModel, model }: {
  store: StreamingStore;
  /** Runs after each visible update is in the DOM. */
  onCommit: (message: AssistantMessage | null) => void;
  toolResults: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
  tokenDisplay: TokenDisplayMode;
  waitingForModel: boolean;
  model: { provider: string; modelId: string } | null;
}) {
  const { root, message } = useSequencedReply(store);
  const { t } = useI18n();
  useLayoutEffect(() => onCommit(message), [message, onCommit, waitingForModel]);
  const waitingMessage = useMemo<AssistantMessage>(() => ({
    role: "assistant",
    content: [],
    provider: model?.provider ?? "",
    model: model?.modelId ?? t("chat.waitingModel"),
  }), [model, t]);
  if (!waitingForModel && (!message || (!message.content.length && tokenDisplay !== "flow"))) return null;
  return <div ref={root} className="contents"><MessageView message={message ?? waitingMessage} toolResults={toolResults} isStreaming live
    modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} tokenDisplay={tokenDisplay} /></div>;
});
