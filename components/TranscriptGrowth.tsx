import { useContext, useLayoutEffect, useRef, type ComponentProps } from "react";
import { ChatAnimationsContext } from "@/hooks/useChatAnimations";
import { createAnimationQueue, type AnimationQueue } from "@/lib/animation-queue";

const REVEAL_THRESHOLD = 48;
const TOOL_GROWTH_MAX_MS = 300;
const toolArrivals = new WeakMap<Element, AnimationQueue>();

/** Ease large insertions and live output bursts without delaying the content itself. */
export function TranscriptGrowth({ live, from, toolArrival, className, children, ...props }: ComponentProps<"div"> & {
  live?: boolean;
  /** Height already on screen, or zero for a new message. */
  from?: number;
  toolArrival?: boolean;
}) {
  const duration = useContext(ChatAnimationsContext);
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const initialHeight = useRef(from);
  const animationRef = useRef<Animation | null>(null);
  const initialToolArrival = useRef(toolArrival);
  const revealRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    const chat = outer?.closest(".chat-content");
    if (!outer || !inner || !chat || !initialToolArrival.current) return;
    if (!duration) {
      initialToolArrival.current = false;
      return;
    }
    let queue = toolArrivals.get(chat);
    if (!queue) {
      queue = createAnimationQueue();
      toolArrivals.set(chat, queue);
    }
    const step = Math.min(duration, TOOL_GROWTH_MAX_MS);
    const frames = [
      { height: "0px", overflow: "clip", visibility: "hidden" },
      { height: `${inner.getBoundingClientRect().height}px`, overflow: "clip", visibility: "visible" },
    ];
    const animation = outer.animate(frames, { duration: step, fill: "backwards", easing: "ease-out" });
    animation.pause();
    animation.currentTime = 0;
    outer.setAttribute("data-tool-entrance-queued", "");
    let cancelled = false;
    const effect = animation.effect as KeyframeEffect;
    const observer = new ResizeObserver(([entry]) => {
      const height = `${entry.contentRect.height}px`;
      if (height === frames[1].height) return;
      frames[1].height = height;
      effect.setKeyframes(frames);
    });
    observer.observe(inner);
    queue.enqueue(() => {
      if (cancelled) return;
      animation.play();
      return animation.finished;
    });
    animation.onfinish = () => {
      outer.removeAttribute("data-tool-entrance-queued");
      initialToolArrival.current = false;
      observer.disconnect();
    };
    return () => {
      cancelled = true;
      outer.removeAttribute("data-tool-entrance-queued");
      observer.disconnect();
      animation.onfinish = null;
      animation.cancel();
    };
  }, [duration]);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    const start = initialHeight.current;
    initialHeight.current = undefined;
    if (!duration) {
      animationRef.current?.cancel();
      return;
    }
    if (!outer || !inner) return;
    if (!live && start === undefined) {
      animationRef.current?.cancel();
      return;
    }
    const animateHeight = (visible: number, height: number, duration: number, easing = "cubic-bezier(.35,.1,.25,1)") => {
      animationRef.current?.cancel();
      const animation = outer.animate([
        { height: `${visible}px`, overflow: "hidden" },
        { height: `${height}px`, overflow: "hidden" },
      ], { duration, easing });
      // Apply the starting height before the parent measures where to scroll.
      animation.currentTime = 0;
      animationRef.current = animation;
    };
    let previous = start ?? inner.offsetHeight;
    const reveal = () => {
      const height = inner.offsetHeight;
      const growth = height - previous;
      if (!growth) return;
      const animation = animationRef.current;
      const remaining = animation?.playState === "running"
        ? Number(animation.effect?.getComputedTiming().endTime ?? 0) - Number(animation.currentTime) : 0;
      previous = height;
      if (initialToolArrival.current) return;
      if (growth < 0) {
        animation?.cancel();
        return;
      }
      if (growth < REVEAL_THRESHOLD && remaining <= 0) return;
      const visible = remaining > 0 ? outer.offsetHeight : height - growth;
      animateHeight(visible, height, growth >= REVEAL_THRESHOLD ? duration : remaining);
    };
    reveal();
    if (live) revealRef.current = reveal;
    const observer = live ? new ResizeObserver(reveal) : undefined;
    observer?.observe(inner);
    return () => {
      revealRef.current = null;
      observer?.disconnect();
    };
  }, [live, duration]);

  // Waiting for ResizeObserver alone lets the scroll follower see full height
  // in the same commit as a large chunk, before the reveal can start.
  useLayoutEffect(() => { revealRef.current?.(); });

  return (
    <div ref={outerRef} className={className ? `transcript-growth ${className}` : "transcript-growth"} {...props}>
      <div ref={innerRef} className="flow-root min-w-0">{children}</div>
    </div>
  );
}
