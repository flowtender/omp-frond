import { useLayoutEffect, type RefObject } from "react";

const landmarks = "[data-token-flow], [data-token-handoff], [data-transcript-block]";
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

/** Connect the model row to its units, and end the output rail at the handoff. */
export function useTokenFlowConnections(enabled: boolean, contentRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!enabled || !content) return;
    let layoutFrame = 0;

    function layout() {
      layoutFrame = 0;
      if (!content) return;
      type Edge = { bounds: DOMRect; block: boolean };
      type Row = { element: HTMLElement; bounds: DOMRect; handoff: boolean; source?: DOMRect; target?: Edge };
      const rows: Row[] = [];
      let previous: { bounds: DOMRect; response: boolean } | undefined;
      let model: Row | undefined;
      for (const element of content.querySelectorAll<HTMLElement>(landmarks)) {
        if (element.closest(".transcript-flow-layout") !== content) continue;
        const bounds = element.getBoundingClientRect();
        if (bounds.height <= 0) continue;
        const handoff = element.hasAttribute("data-token-handoff");
        const block = !handoff && !element.hasAttribute("data-token-flow");
        if (model) model.target = { bounds, block };
        if (block) {
          previous = { bounds, response: element.dataset.transcriptBlock === "response" };
          model = undefined;
        } else {
          const row = { element, bounds, handoff, source: previous?.response === handoff ? previous.bounds : undefined };
          rows.push(row);
          model = handoff ? undefined : row;
          previous = undefined;
        }
      }

      for (const { element, bounds, handoff, source, target } of rows) {
        const left = bounds.width * 0.25;
        const right = bounds.width * 0.75;
        const startY = source ? source.bottom - bounds.top : 0;
        const path = element.querySelector("path");
        if (handoff) {
          const lineY = bounds.height / 2;
          const fromX = source ? source.left + source.width * 0.75 - bounds.left : right;
          const input = verticalConnector(fromX, startY, right, lineY - radius);
          const endY = Math.min(bounds.height - 4, lineY + radius + 6);
          path?.setAttribute("d", `M${fromX} ${startY} ${input} q0 ${radius} ${-radius} ${radius} H${left + radius} q${-radius} 0 ${-radius} ${radius} V${endY} ${arrow(left, endY)}`);
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
    }

    const schedule = () => { if (!layoutFrame) layoutFrame = requestAnimationFrame(layout); };
    const resize = new ResizeObserver(schedule);
    resize.observe(content);
    const mutation = new MutationObserver(schedule);
    mutation.observe(content, { childList: true, subtree: true, attributeFilter: ["data-transcript-block"] });
    content.addEventListener("load", schedule, true);
    layout();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      content.removeEventListener("load", schedule, true);
      cancelAnimationFrame(layoutFrame);
    };
  }, [enabled, contentRef]);
}
