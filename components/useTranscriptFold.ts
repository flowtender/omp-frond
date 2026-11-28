import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { ChatAnimationsContext } from "@/hooks/useChatAnimations";

export function useTranscriptFold(collapsed: boolean, instant: boolean, flow: boolean) {
  const duration = useContext(ChatAnimationsContext);
  const [retained, setRetained] = useState(!collapsed);
  const detailsRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const openingCoverRef = useRef<HTMLDivElement>(null);
  const previousCollapsed = useRef(collapsed);
  const heightAnimation = useRef<Animation | null>(null);
  const bracketRef = useRef<HTMLDivElement>(null);
  const bracketAnimation = useRef<Animation | null>(null);
  const openingCover = useRef<Animation[]>([]);
  const [bracketsMoving, setBracketsMoving] = useState(false);
  const showDetails = !collapsed || (duration > 0 && retained);

  const cancelTransition = useCallback(() => {
    for (const animation of [heightAnimation.current, bracketAnimation.current, ...openingCover.current]) {
      if (!animation) continue;
      animation.onfinish = null;
      animation.cancel();
    }
    heightAnimation.current = null;
    bracketAnimation.current = null;
    openingCover.current = [];
  }, []);

  useLayoutEffect(() => {
    const changed = collapsed !== previousCollapsed.current;
    previousCollapsed.current = collapsed;
    if (!collapsed) setRetained(true);
    else if (!duration || instant) setRetained(false);
    const details = detailsRef.current;
    const previous = heightAnimation.current;
    if (!details || !duration || instant) {
      cancelTransition();
      setBracketsMoving(false);
      return;
    }
    if (!changed) return;
    const content = contentRef.current;
    const height = content?.getBoundingClientRect().height ?? 0;
    const bracket = flow ? bracketRef.current : null;
    const summary = bracket ? summaryRef.current?.getBoundingClientRect() : undefined;
    const compactHeight = summary?.height ?? 0;
    const from = previous?.playState === "running" ? details.getBoundingClientRect().height : collapsed ? height : compactHeight;
    const to = collapsed ? compactHeight : height;
    cancelTransition();
    const distance = Math.abs(from - to);
    if (!bracket && (height === 0 || distance === 0)) {
      if (collapsed) setRetained(false);
      return;
    }
    const phaseDuration = duration / 2;
    if (bracket) {
      const compact = `${summary?.width || bracket.offsetWidth}px`;
      const sweep = bracket.animate([
        { width: compact, offset: 0 },
        { width: "100%", offset: 1 / 3 },
        { width: "100%", offset: 2 / 3 },
        { width: compact, offset: 1 },
      ], { duration: 3 * phaseDuration, easing: "linear" });
      sweep.currentTime = 0;
      const cover = openingCoverRef.current;
      if (!collapsed && cover && content) {
        openingCover.current = [
          cover.animate([{ visibility: "visible" }, { visibility: "visible" }], phaseDuration),
          content.animate([{ visibility: "hidden" }, { visibility: "hidden" }], phaseDuration),
        ];
        for (const effect of openingCover.current) effect.currentTime = 0;
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
    heightAnimation.current = animation;
    animation.onfinish = () => {
      if (collapsed) setRetained(false);
      if (!collapsed) animation.cancel();
      heightAnimation.current = null;
    };
  }, [collapsed, duration, instant, flow, cancelTransition]);

  useLayoutEffect(() => cancelTransition, [cancelTransition]);

  return { detailsRef, contentRef, summaryRef, openingCoverRef, bracketRef, showDetails, bracketsMoving, measureBrackets: flow && duration > 0 };
}
