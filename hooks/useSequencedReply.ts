import { useContext, useLayoutEffect, useRef, useState } from "react";
import type { AssistantMessage } from "@/lib/types";
import type { StreamingStore } from "@/lib/streaming-message";
import { ChatAnimationsContext } from "./useChatAnimations";
import { usePacedStreamingMessage } from "./useStreamingSelector";

export function useSequencedReply(store: StreamingStore) {
  const source = usePacedStreamingMessage(store);
  const animated = useContext(ChatAnimationsContext) > 0;
  const root = useRef<HTMLDivElement>(null);
  const [ending, setEnding] = useState<AssistantMessage | null>(null);

  useLayoutEffect(() => {
    if (!animated) return;
    let latest = store.getState().streamingMessage;
    return store.subscribe(() => {
      const next = store.getState().streamingMessage;
      // Keep the authoritative last snapshot, even if React batched its delta
      // with the event that removed the live reply.
      if (!next && latest && !document.hidden) setEnding(latest);
      latest = next;
    });
  }, [store, animated]);

  useLayoutEffect(() => {
    if (!ending) return;
    if (source || !animated || document.hidden) {
      setEnding(null);
      return;
    }
    const fades = root.current?.getAnimations({ subtree: true }).filter(
      (animation) => "animationName" in animation && animation.animationName === "streaming-prose-fade"
        && animation.playState !== "finished",
    );
    if (!fades?.length) {
      setEnding(null);
      return;
    }
    const finish = () => setEnding((current) => current === ending ? null : current);
    const onVisibility = () => {
      if (document.hidden) finish();
    };
    let active = true;
    void Promise.allSettled(fades.map((animation) => animation.finished)).then(() => { if (active) finish(); });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [source, ending, animated]);

  return { root, message: source ?? (animated ? ending : null) };
}
