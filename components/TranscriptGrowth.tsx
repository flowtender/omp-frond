import { useContext, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { ChatAnimationsContext } from "@/hooks/useChatAnimations";
import { createAnimationQueue, type AnimationQueue } from "@/lib/animation-queue";

const REVEAL_THRESHOLD = 48;
const TOOL_GROWTH_MAX_MS = 300;
const toolArrivals = new WeakMap<Element, AnimationQueue>();

export function useTranscriptFold(collapsed: boolean, instant: boolean, flow = false) {
  const duration = useContext(ChatAnimationsContext);
  const [retained, setRetained] = useState(!collapsed);
  const detailsRef = useRef<HTMLDivElement>(null);
  const previousCollapsed = useRef(collapsed);
  const animationRef = useRef<Animation | null>(null);
  const bracketRef = useRef<HTMLDivElement>(null);
  const bracketAnimation = useRef<Animation | null>(null);
  const openingCover = useRef<Animation[]>([]);
  const [bracketsMoving, setBracketsMoving] = useState(false);
  const showDetails = !collapsed || (duration > 0 && retained);

  useLayoutEffect(() => {
    const changed = collapsed !== previousCollapsed.current;
    previousCollapsed.current = collapsed;
    if (!collapsed) setRetained(true);
    else if (!duration || instant) setRetained(false);
    const details = detailsRef.current;
    const previous = animationRef.current;
    for (const cover of openingCover.current) cover.cancel();
    openingCover.current = [];
    if (!details || !duration || instant) {
      previous?.cancel();
      if (previous) previous.onfinish = null;
      animationRef.current = null;
      bracketAnimation.current?.cancel();
      setBracketsMoving(false);
      return;
    }
    if (!changed) return;
    const height = details.firstElementChild?.getBoundingClientRect().height ?? 0;
    const bracket = flow ? bracketRef.current : null;
    const summary = bracket?.parentElement?.querySelector(".token-flow-fold-body");
    const compactHeight = summary?.getBoundingClientRect().height ?? 0;
    const from = previous?.playState === "running" ? details.getBoundingClientRect().height : collapsed ? height : compactHeight;
    const to = collapsed ? compactHeight : height;
    previous?.cancel();
    const distance = Math.abs(from - to);
    if (!bracket && (height === 0 || distance === 0)) {
      if (collapsed) setRetained(false);
      return;
    }
    const phaseDuration = duration / 2;
    if (bracket) {
      const compact = `${summary?.getBoundingClientRect().width || bracket.offsetWidth}px`;
      bracketAnimation.current?.cancel();
      const sweep = bracket.animate([
        { width: compact, offset: 0 },
        { width: "100%", offset: 1 / 3 },
        { width: "100%", offset: 2 / 3 },
        { width: compact, offset: 1 },
      ], { duration: 3 * phaseDuration, easing: "linear" });
      sweep.currentTime = 0;
      if (!collapsed && summary) {
        const cover = summary.parentElement?.parentElement;
        const content = details.firstElementChild;
        if (cover && content) {
          openingCover.current = [
            cover.animate([{ visibility: "visible" }, { visibility: "visible" }], phaseDuration),
            content.animate([{ visibility: "hidden" }, { visibility: "hidden" }], phaseDuration),
          ];
          for (const effect of openingCover.current) effect.currentTime = 0;
        }
      }
      bracketAnimation.current = sweep;
      setBracketsMoving(true);
      sweep.onfinish = () => {
        bracketAnimation.current = null;
        setBracketsMoving(false);
      };
    }
    const animation = details.animate([
      { height: `${from}px`, overflow: "clip" },
      { height: `${to}px`, overflow: "clip" },
    ], { delay: bracket ? phaseDuration : 0, duration: bracket ? phaseDuration : phaseDuration * distance / height,
      easing: "linear", fill: bracket ? "both" : collapsed ? "forwards" : "none" });
    animation.currentTime = 0;
    animationRef.current = animation;
    animation.onfinish = () => {
      if (collapsed) setRetained(false);
      if (!collapsed) animation.cancel();
      animationRef.current = null;
    };
  }, [collapsed, duration, instant, flow]);

  useLayoutEffect(() => () => {
    bracketAnimation.current?.cancel();
    for (const cover of openingCover.current) cover.cancel();
    const animation = animationRef.current;
    if (animation) {
      animation.onfinish = null;
      animation.cancel();
    }
  }, []);

  return { detailsRef, showDetails, bracketRef, bracketsMoving, measureBrackets: flow && duration > 0 };
}

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
