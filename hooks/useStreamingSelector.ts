"use client";

import { useContext, useLayoutEffect, useState } from "react";
import type { StreamingState, StreamingStore } from "@/lib/streaming-message";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { revealStreamingMessage } from "@/lib/streaming-presentation";
import { ChatAnimationsContext } from "./useChatAnimations";

/**
 * One value of the streaming store; the component re-renders only when that
 * value changes. `select` must be stable (a module-level function).
 *
 * A plain state update rather than useSyncExternalStore: that one renders every
 * chunk on its own, while state updates let React batch the chunks that land
 * before it renders, and each render parses the reply's last block again.
 */
export function useStreamingSelector<T>(store: StreamingStore, select: (state: StreamingState) => T): T {
  const [value, setValue] = useState(() => select(store.getState()));
  useLayoutEffect(() => {
    const update = () => setValue(select(store.getState()));
    // A chunk may have landed between this render and the subscription.
    update();
    return store.subscribe(update);
  }, [store, select]);
  return value;
}

export const selectIsStreaming = (state: StreamingState) => state.isStreaming;
export const selectHasStreamingContent = (state: StreamingState) => Boolean(state.streamingMessage?.content.length);

const REVEAL_MS = 90;
const MIN_PAINT_INTERVAL_MS = 30;
const CODE_BLOCK_LINE = /(?:^|\n)(?:[ \t]*(?:`{3,}|~{3,})| {4}|\t)/;

export function usePacedStreamingMessage(store: StreamingStore) {
  const chatAnimations = useContext(ChatAnimationsContext) > 0;
  const [message, setMessage] = useState(() => store.getState().streamingMessage);
  useLayoutEffect(() => {
    let shown = store.getState().streamingMessage;
    let target = shown;
    let frame: number | null = null;
    let lastPaintAt = -Infinity;
    let deadline = 0;
    setMessage(shown);

    const flush = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      shown = target;
      setMessage(shown);
    };
    const reveal = () => {
      frame = null;
      const now = performance.now();
      const elapsed = now - lastPaintAt;
      if (elapsed >= MIN_PAINT_INTERVAL_MS || now >= deadline) {
        shown = revealStreamingMessage(shown, target, elapsed / (deadline - lastPaintAt));
        lastPaintAt = now;
        setMessage(shown);
      }
      if (shown !== target) frame = requestAnimationFrame(reveal);
    };
    const update = () => {
      const next = store.getState().streamingMessage;
      if (next === target) return;
      target = next;
      // Keep the start/end of a reply in the same commit as the transcript change.
      const tail = target?.content.at(-1);
      if (!shown || !target || !chatAnimations || document.hidden
        || (tail?.type === "text" && !CODE_BLOCK_LINE.test(splitMarkdownBlocks(tail.text).at(-1) ?? ""))) {
        flush();
      } else if (frame === null) {
        const now = performance.now();
        lastPaintAt = Math.max(lastPaintAt, now - MIN_PAINT_INTERVAL_MS);
        deadline = now + REVEAL_MS;
        frame = requestAnimationFrame(reveal);
      }
    };

    const unsubscribe = store.subscribe(update);
    document.addEventListener("visibilitychange", flush);
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [store, chatAnimations]);
  return message;
}
