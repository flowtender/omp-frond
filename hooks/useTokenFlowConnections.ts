import { useLayoutEffect, type RefObject } from "react";

const landmarks = "[data-token-flow], [data-token-handoff], [data-transcript-block], [data-transcript-gap]";
const radius = 8;

function arrow(x: number, y: number): string {
  return `M${x - 3.5} ${y - 4} L${x} ${y} l3.5 -4`;
}

/** Shift rails between a full-width flow row and a narrower, right-aligned bubble. */
function verticalConnector(fromX: number, fromY: number, toX: number, toY: number): string {
  const delta = toX - fromX;
  const bend = Math.min(radius, Math.abs(delta) / 2, (toY - fromY) / 4);
  if (bend < 0.5) return `L${toX} ${toY}`;
  const direction = Math.sign(delta);
  const y = (fromY + toY) / 2;
  return `V${y - bend} q0 ${bend} ${direction * bend} ${bend} H${toX - direction * bend} q${direction * bend} 0 ${direction * bend} ${bend} V${toY}`;
}

/** Connect model and handoff rows to the adjacent transcript units. */
export function useTokenFlowConnections(
  enabled: boolean,
  contentRef: RefObject<HTMLDivElement | null>,
  composerWireRef?: RefObject<SVGSVGElement | null>,
) {
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!enabled || !content) return;
    const composerWire = composerWireRef?.current;
    const composer = composerWire?.parentElement?.querySelector<HTMLElement>("[data-token-flow-composer]");
    const scroller = composer && content.closest("[data-chat-transcript-scroll]");
    const composerPath = composerWire?.querySelector("path");
    let composerHandoff: { row: HTMLElement; path: SVGPathElement; base: string; fallback: string } | undefined;
    let scrollFrame = 0;
    let composerConnected = false;
    let layoutFrame = 0;

    function drawComposerHandoff() {
      const handoff = composerHandoff;
      if (!handoff || !composerWire || !composer || !scroller || !composerPath) return;
      const row = handoff.row.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      const target = composer.getBoundingClientRect();
      const start = row.top + row.height / 2 + radius;
      const connect = start >= viewport.top && start < viewport.bottom && target.top >= start + 4;
      if (connect !== composerConnected) {
        handoff.path.setAttribute("d", connect ? handoff.base : handoff.fallback);
        composerConnected = connect;
      }
      if (!connect) {
        composerPath.removeAttribute("d");
        return;
      }
      const origin = composerWire.getBoundingClientRect();
      const x = row.left + row.width * 0.25 - origin.left;
      const y = start - origin.top;
      const toY = target.top - origin.top;
      composerPath.setAttribute("d", `M${x} ${y} V${toY} ${arrow(x, toY)}`);
    }

    function layout() {
      layoutFrame = 0;
      if (!content) return;
      type Edge = { bounds: DOMRect; block: boolean };
      type Row = { element: HTMLElement; bounds: DOMRect; handoff: boolean; source?: DOMRect; target?: Edge };
      const rows: Row[] = [];
      // The landmark a following row wires in from: the process fold header sits
      // between a bubble and the turn's first row, so a row may feed another row.
      let last: DOMRect | undefined;
      let previousRow: Row | undefined;
      for (const element of content.querySelectorAll<HTMLElement>(landmarks)) {
        if (element.closest(".transcript-flow-layout") !== content) continue;
        if (element.hasAttribute("data-transcript-gap")) {
          last = previousRow = undefined;
          continue;
        }
        const bounds = element.getBoundingClientRect();
        if (bounds.height <= 0) continue;
        const handoff = element.hasAttribute("data-token-handoff");
        const block = !handoff && !element.hasAttribute("data-token-flow");
        if (previousRow) previousRow.target = { bounds, block };
        if (block) {
          last = bounds;
          previousRow = undefined;
        } else {
          const row = { element, bounds, handoff, source: last };
          rows.push(row);
          previousRow = row;
          last = bounds;
        }
      }

      composerHandoff = undefined;
      composerConnected = false;
      composerPath?.removeAttribute("d");
      for (const { element, bounds, handoff, source, target } of rows) {
        const left = bounds.width * 0.25;
        const right = bounds.width * 0.75;
        const startY = source ? source.bottom - bounds.top : 0;
        const path = element.querySelector<SVGPathElement>("path");
        if (handoff) {
          const lineY = bounds.height / 2;
          const fromX = source ? source.left + source.width * 0.75 - bounds.left : right;
          const input = verticalConnector(fromX, startY, right, lineY - radius);
          const toX = target ? target.bounds.left + target.bounds.width * 0.25 - bounds.left : left;
          const endY = target ? target.bounds.top - bounds.top : Math.min(bounds.height - 4, lineY + radius + 6);
          const output = verticalConnector(left, lineY + radius, toX, endY);
          const base = `M${fromX} ${startY} ${input} q0 ${radius} ${-radius} ${radius} H${left + radius} q${-radius} 0 ${-radius} ${radius}`;
          const fallback = `${base} ${output} ${arrow(toX, endY)}`;
          path?.setAttribute("d", fallback);
          // A trailing user handoff hands to the composer even when a streaming
          // model row now follows it; a real next bubble (a block) takes over.
          if (composerPath && path && previousRow?.element === element && (!target || !target.block) && element.dataset.tokenHandoff === "user") {
            composerHandoff = { row: element, path, base, fallback };
          }
          continue;
        }
        const endY = target ? target.bounds.top - bounds.top : bounds.height;
        const lineY = (startY + endY) / 2;
        const inputX = source ? source.left + source.width * 0.25 - bounds.left : left;
        const outputX = target ? target.bounds.left + target.bounds.width * 0.75 - bounds.left : right;
        const input = verticalConnector(inputX, startY, left, lineY - radius);
        const output = verticalConnector(right, lineY + radius, outputX, endY);
        element.style.setProperty("--token-flow-offset", `${lineY - bounds.height / 2}px`);
        path?.setAttribute("d", `M${inputX} ${startY} ${input} q0 ${radius} ${radius} ${radius} H${right - radius} q${radius} 0 ${radius} ${radius} ${output}${target?.block ? ` ${arrow(outputX, endY)}` : ""}`);
      }
      drawComposerHandoff();
    }

    const schedule = () => { if (!layoutFrame) layoutFrame = requestAnimationFrame(layout); };
    const onScroll = () => {
      if (scrollFrame || !composerHandoff) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        drawComposerHandoff();
      });
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(content);
    if (composer && scroller) {
      resize.observe(composer);
      resize.observe(scroller);
      scroller.addEventListener("scroll", onScroll, { passive: true });
    }
    const mutation = new MutationObserver(schedule);
    mutation.observe(content, { childList: true, subtree: true, attributeFilter: ["data-transcript-block", "data-transcript-gap"] });
    content.addEventListener("load", schedule, true);
    layout();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      content.removeEventListener("load", schedule, true);
      cancelAnimationFrame(layoutFrame);
      scroller?.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(scrollFrame);
    };
  }, [enabled, contentRef, composerWireRef]);
}
