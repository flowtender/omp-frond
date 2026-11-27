import { useContext, useLayoutEffect, useRef, useState } from "react";
import { createAnimationQueue } from "@/lib/animation-queue";
import type { StreamingStore } from "@/lib/streaming-message";
import { ChatAnimationsContext } from "./useChatAnimations";
import { usePacedStreamingMessage } from "./useStreamingSelector";

export function useSequencedReply(store: StreamingStore) {
  const source = usePacedStreamingMessage(store);
  const animated = useContext(ChatAnimationsContext) > 0;
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(source);
  const [queue] = useState(createAnimationQueue);
  const pending = useRef(false);
  const committed = useRef(shown);
  const finalSnapshot = useRef(source);
  const latest = useRef(source);
  const afterCommit = useRef<(() => void) | null>(null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      afterCommit.current?.();
      afterCommit.current = null;
    };
  }, []);

  useLayoutEffect(() => store.subscribe(() => {
    const snapshot = store.getState().streamingMessage;
    if (snapshot) finalSnapshot.current = snapshot;
  }), [store]);

  useLayoutEffect(() => {
    committed.current = shown;
    const finish = afterCommit.current;
    afterCommit.current = null;
    finish?.();
  }, [shown]);

  useLayoutEffect(() => {
    latest.current = source;
    if (!animated || document.hidden) {
      finalSnapshot.current = source;
      setShown(source);
      return;
    }
    if (source === shown || pending.current) return;
    pending.current = true;
    queue.enqueue(() => {
      pending.current = false;
      const next = latest.current ?? finalSnapshot.current;
      if (!latest.current) finalSnapshot.current = null;
      if (!mounted.current) return;
      if (next === committed.current) {
        if (!latest.current && next) setShown(null);
        return;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      afterCommit.current = () => {
        const fades = root.current?.getAnimations({ subtree: true }).filter(
          (animation) => "animationName" in animation && animation.animationName === "streaming-prose-fade",
        );
        if (fades?.length) void Promise.allSettled(fades.map((animation) => animation.finished)).then(() => resolve());
        else resolve();
      };
      setShown(next);
      return promise;
    });
  }, [source, animated, queue, shown]);

  return { root, message: animated ? shown : source };
}
