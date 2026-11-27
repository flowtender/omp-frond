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

/** Leave the box above, turn toward the center at once, then drop into the bracket. */
function foldEntry(fromX: number, startY: number, centerX: number, bracketTop: number): string {
  const delta = centerX - fromX;
  if (Math.abs(delta) < 1) return `M${fromX} ${startY} V${bracketTop}`;
  const turn = Math.sign(delta);
  const bend = Math.min(radius, Math.abs(delta) / 2);
  const cornerY = Math.max(startY + bend, Math.min(startY + 2 * radius, bracketTop - bend));
  return `M${fromX} ${startY} V${cornerY - bend} q0 ${bend} ${turn * bend} ${bend} H${centerX - turn * bend} q${turn * bend} 0 ${turn * bend} ${bend} V${bracketTop}`;
}
const portRails = {
  model: { entry: 0.75, exit: 0.25, box: false },
  fold: { entry: 0.75, exit: 0.5, box: false },
  handoff: { entry: 0.25, exit: 0.75, box: false },
  input: { entry: 0.75, exit: 0.75, box: true },
  output: { entry: 0.25, exit: 0.25, box: true },
} as const;
type Port = keyof typeof portRails;

/** Connect model and handoff rows to the adjacent transcript units. */
export function useTokenFlowConnections(
  enabled: boolean,
  contentRef: RefObject<HTMLDivElement | null>,
  composerWireRef?: RefObject<SVGSVGElement | null>,
  explicitPorts = false,
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
      const x = row.left + row.width * portRails.handoff.exit - origin.left;
      const y = start - origin.top;
      const toY = target.top - origin.top;
      composerPath.setAttribute("d", `M${x} ${y} V${toY} ${arrow(x, toY)}`);
    }

    function layout() {
      layoutFrame = 0;
      if (!content) return;
      type Edge = { bounds: DOMRect; port: Port; block: boolean };
      type Row = Edge & { element: HTMLElement; source?: Edge; target?: Edge };
      const rows: Row[] = [];
      let previous: Edge | undefined;
      let previousRow: Row | undefined;
      const selector = explicitPorts ? "[data-transcript-port], [data-transcript-gap]" : landmarks;
      for (const element of content.querySelectorAll<HTMLElement>(selector)) {
        if (element.closest(".transcript-flow-layout") !== content) continue;
        if (element.hasAttribute("data-transcript-gap")) {
          previous = previousRow = undefined;
          continue;
        }
        const port = explicitPorts ? element.dataset.transcriptPort as Port
          : element.hasAttribute("data-token-handoff") ? "handoff"
          : element.hasAttribute("data-token-flow") ? "model"
          : element.dataset.transcriptBlock === "response" ? "output" : "input";
        // Transcript views declare the semantic port; the inner box supplies its geometry.
        const block = portRails[port].box;
        const box = explicitPorts && block && !element.hasAttribute("data-transcript-block")
          ? element.querySelector("[data-transcript-block]") ?? element : element;
        const bounds = box.getBoundingClientRect();
        if (bounds.height <= 0) continue;
        const edge: Edge = { bounds, port, block };
        if (previousRow && !(previousRow.port === "handoff" && port === "output")) previousRow.target = edge;
        if (block) {
          previousRow = undefined;
          previous = edge;
        } else {
          const row: Row = { ...edge, element, source: previous?.block ? previous : undefined };
          rows.push(row);
          previous = previousRow = row;
        }
      }

      composerHandoff = undefined;
      composerConnected = false;
      composerPath?.removeAttribute("d");
      for (const row of rows) {
        const { element, bounds, port, source, target } = row;
        const entryX = bounds.width * portRails[port].entry;
        const exitX = bounds.width * portRails[port].exit;
        // The wire turns toward the exit rail: left when the flow enters on the right.
        const turn = Math.sign(exitX - entryX);
        const startY = source ? source.bounds.bottom - bounds.top : 0;
        const path = element.querySelector<SVGPathElement>(":scope > .token-flow-wire > path");
        const fromX = source ? source.bounds.left + source.bounds.width * portRails[source.port].exit - bounds.left : entryX;
        const toX = target ? target.bounds.left + target.bounds.width * portRails[target.port].entry - bounds.left : exitX;
        const turnDown = `q0 ${radius} ${turn * radius} ${radius} H${exitX - turn * radius} q${turn * radius} 0 ${turn * radius} ${radius}`;
        if (port === "fold") {
          const body = element.querySelector(".token-flow-fold-body")?.getBoundingClientRect();
          if (!body) continue;
          const centerX = bounds.width / 2;
          const bodyTop = body.top - bounds.top;
          const endY = target ? target.bounds.top - bounds.top : bounds.height;
          const intoBracket = foldEntry(fromX, startY, centerX, bodyTop);
          const outOfBracket = verticalConnector(centerX, body.bottom - bounds.top, toX, endY);
          path?.setAttribute("d", `${intoBracket} M${centerX} ${body.bottom - bounds.top} ${outOfBracket}${target?.port === "output" ? ` ${arrow(toX, endY)}` : ""}`);
          continue;
        }
        if (port === "handoff") {
          const lineY = bounds.height / 2;
          const input = verticalConnector(fromX, startY, entryX, lineY - radius);
          const endY = target ? target.bounds.top - bounds.top : Math.min(bounds.height - 4, lineY + radius + 6);
          const output = verticalConnector(exitX, lineY + radius, toX, endY);
          const base = `M${fromX} ${startY} ${input} ${turnDown}`;
          const fallback = `${base} ${output}${target?.block || !target ? ` ${arrow(toX, endY)}` : ""}`;
          path?.setAttribute("d", fallback);
          if (composerPath && path && previousRow?.element === element && !target && element.dataset.tokenHandoff === "user") {
            composerHandoff = { row: element, path, base, fallback };
          }
          continue;
        }
        const endY = target ? target.bounds.top - bounds.top : bounds.height;
        const lineY = (startY + endY) / 2;
        element.style.setProperty("--token-flow-offset", `${lineY - bounds.height / 2}px`);
        const input = verticalConnector(fromX, startY, entryX, lineY - radius);
        const output = verticalConnector(exitX, lineY + radius, toX, endY);
        path?.setAttribute("d", `M${fromX} ${startY} ${input} ${turnDown} ${output}${target?.port === "output" ? ` ${arrow(toX, endY)}` : ""}`);
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
    mutation.observe(content, { childList: true, subtree: true, attributeFilter: ["data-transcript-port", "data-transcript-block", "data-transcript-gap"] });
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
  }, [enabled, contentRef, composerWireRef, explicitPorts]);
}
