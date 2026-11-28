import { useLayoutEffect, type RefObject } from "react";

const landmarks = "[data-transcript-port], [data-transcript-gap]";
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
function foldEntry(fromX: number, startY: number, centerX: number, bracketTop: number, direction = 1): string {
  const delta = centerX - fromX;
  if (Math.abs(delta) < 1) return `M${fromX} ${startY} V${bracketTop}`;
  const turn = Math.sign(delta);
  const bend = Math.min(radius, Math.abs(delta) / 2, Math.max(0, direction * (bracketTop - startY) / 2));
  const cornerY = bracketTop - direction * bend;
  return `M${fromX} ${startY} V${cornerY - direction * bend} q0 ${direction * bend} ${turn * bend} ${direction * bend} H${centerX - turn * bend} q${turn * bend} 0 ${turn * bend} ${direction * bend} V${bracketTop}`;
}
const portRails = {
  model: { entry: 0.75, exit: 0.25, box: false },
  fold: { entry: 0.75, exit: 0.5, box: false },
  process: { entry: 0.75, exit: 0.75, box: false },
  "process-end": { entry: 0.25, exit: 0.25, box: false },
  handoff: { entry: 0.25, exit: 0.75, box: false },
  input: { entry: 0.75, exit: 0.75, box: true },
  output: { entry: 0.25, exit: 0.25, box: true },
} as const;
type Port = keyof typeof portRails;

// `rail` is the full-width row the rails are measured on; `bounds` is the box the wire touches vertically.
type Edge = { bounds: DOMRect; rail: DOMRect; port: Port; block: boolean };
type Row = Edge & {
  element: HTMLElement;
  source?: Edge;
  target?: Edge;
  foldBody?: DOMRect;
  foldSlot?: DOMRect;
  foldExit?: DOMRect;
};

function drawRow(row: Row) {
  const { bounds, port, source, target } = row;
  const entryX = bounds.width * portRails[port].entry;
  const exitX = bounds.width * portRails[port].exit;
  const startY = source ? source.bounds.bottom - bounds.top : 0;
  const fromX = source ? source.rail.left + source.rail.width * portRails[source.port].exit - bounds.left : entryX;
  const toX = target ? target.rail.left + target.rail.width * portRails[target.port].entry - bounds.left : exitX;
  if (port === "fold") {
    const { foldBody: body, foldSlot: slot, foldExit: exit } = row;
    if (!body || !slot || !exit) return;
    const centerX = bounds.width / 2;
    const endY = target ? target.bounds.top - bounds.top : bounds.height;
    const intoToggle = foldEntry(fromX, startY, centerX, slot.top - bounds.top);
    const outOfBracket = foldEntry(toX, endY, centerX, exit.bottom - bounds.top, -1);
    return { kind: "single", path: `${intoToggle} V${body.top - bounds.top} ${outOfBracket} V${body.bottom - bounds.top}${target?.port === "output" ? ` ${arrow(toX, endY)}` : ""}` } as const;
  }
  if (port === "process" || port === "process-end") {
    // The toggle sits on the wire where it arrives, whichever rail that is; only below it may the wire shift.
    const toggleBottom = bounds.height / 2 + 14;
    const endY = target ? target.bounds.top - bounds.top : bounds.height;
    return { kind: "process", offset: fromX, path: `M${fromX} ${startY} V${toggleBottom} ${verticalConnector(fromX, toggleBottom, toX, endY)}${target?.port === "output" ? ` ${arrow(toX, endY)}` : ""}` } as const;
  }
  if (port === "handoff") {
    // The wire turns toward the exit rail: left when the flow enters on the right.
    const turn = Math.sign(exitX - entryX);
    const turnDown = `q0 ${radius} ${turn * radius} ${radius} H${exitX - turn * radius} q${turn * radius} 0 ${turn * radius} ${radius}`;
    const lineY = bounds.height / 2;
    const input = verticalConnector(fromX, startY, entryX, lineY - radius);
    const endY = target ? target.bounds.top - bounds.top : Math.min(bounds.height - 4, lineY + radius + 6);
    const output = verticalConnector(exitX, lineY + radius, toX, endY);
    const base = `M${fromX} ${startY} ${input} ${turnDown}`;
    const fallback = `${base} ${output}${target?.block || !target ? ` ${arrow(toX, endY)}` : ""}`;
    return { kind: "handoff", base, fallback } as const;
  }
  const endY = target ? target.bounds.top - bounds.top : bounds.height;
  const lineY = (startY + endY) / 2;
  const input = verticalConnector(fromX, startY, entryX, lineY - radius);
  const output = verticalConnector(exitX, lineY + radius, toX, endY);
  const centerX = bounds.width / 2;
  const inputRail = `M${fromX} ${startY} ${input} q0 ${radius} ${-radius} ${radius} H${centerX}`;
  const outputRail = `M${centerX} ${lineY} H${exitX + radius} q${-radius} 0 ${-radius} ${radius} ${output}`;
  return { kind: "model", offset: lineY - bounds.height / 2, inputRail, outputRail,
    arrowPath: target?.port === "output" ? arrow(toX, endY) : undefined } as const;
}

function updatePath(path: Element | null | undefined, drawing?: string) {
  if (!path) return;
  const previous = path.getAttribute("d");
  if (drawing === undefined) {
    if (previous !== null) path.removeAttribute("d");
  } else if (drawing !== previous) {
    path.setAttribute("d", drawing);
  }
}

function updateOffset(element: HTMLElement, property: string, offset: number) {
  const value = `${offset}px`;
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
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
    let layoutFrame = 0;

    function measureComposerPath(row: DOMRect | undefined) {
      if (!row || !composerWire || !composer || !scroller || !composerPath) return;
      const viewport = scroller.getBoundingClientRect();
      const target = composer.getBoundingClientRect();
      const start = row.top + row.height / 2 + radius;
      if (start < viewport.top || start >= viewport.bottom || target.top < start + 4) return;
      const origin = composerWire.getBoundingClientRect();
      const x = row.left + row.width * portRails.handoff.exit - origin.left;
      const y = start - origin.top;
      const toY = target.top - origin.top;
      return `M${x} ${y} V${toY} ${arrow(x, toY)}`;
    }

    function layout() {
      layoutFrame = 0;
      if (!content) return;
      // Measure all boxes before touching SVG or inline styles.
      const rows: Row[] = [];
      const foldClips = new Map<Element, { bottom: number; hidden: boolean }>();
      let previous: Edge | undefined;
      let previousRow: Row | undefined;
      for (const element of content.querySelectorAll<HTMLElement>(landmarks)) {
        if (element.closest(".transcript-flow-layout") !== content) continue;
        if (element.hasAttribute("data-transcript-gap")) {
          previous = previousRow = undefined;
          continue;
        }
        const port = element.dataset.transcriptPort as Port;
        // Transcript views declare the semantic port; the inner box supplies its geometry.
        const block = portRails[port].box;
        const box = block && !element.hasAttribute("data-transcript-block")
          ? element.querySelector("[data-transcript-block]") ?? element : element;
        const bounds = box.getBoundingClientRect();
        const fold = element.closest("[data-fold-moving] > [data-fold-details]");
        if (fold) {
          let clip = foldClips.get(fold);
          if (!clip) {
            clip = { bottom: fold.getBoundingClientRect().bottom,
              hidden: getComputedStyle(fold.firstElementChild ?? fold).visibility === "hidden" };
            foldClips.set(fold, clip);
          }
          if (clip.hidden || bounds.bottom > clip.bottom + 0.5) continue;
        }
        if (bounds.height <= 0) continue;
        const edge: Edge = { bounds, rail: box === element ? bounds : element.getBoundingClientRect(), port, block };
        if (previousRow && !(previousRow.port === "handoff" && port === "output")) previousRow.target = edge;
        if (block) {
          previousRow = undefined;
          previous = edge;
        } else {
          const row: Row = { ...edge, element, source: previous?.block ? previous : undefined };
          if (port === "fold") {
            row.foldBody = element.querySelector(".token-flow-fold-body")?.getBoundingClientRect();
            row.foldSlot = element.querySelector(".token-flow-fold-toggle-slot")?.getBoundingClientRect();
            row.foldExit = element.querySelector(".token-flow-fold-toggle-slot-bottom")?.getBoundingClientRect();
          }
          rows.push(row);
          previous = previousRow = row;
        }
      }

      const lastHandoff = previousRow?.port === "handoff" && !previousRow.target
        && previousRow.element.dataset.tokenHandoff === "user" ? previousRow : undefined;
      const composerDrawing = measureComposerPath(lastHandoff?.bounds);
      composerHandoff = undefined;
      for (const row of rows) {
        const drawing = drawRow(row);
        if (!drawing) continue;
        const { element } = row;
        const wire = element.querySelector<SVGSVGElement>(":scope > .token-flow-wire");
        if (drawing.kind === "model") {
          updateOffset(element, "--token-flow-offset", drawing.offset);
          updatePath(wire?.querySelector('[data-flow-rail="input"]'), drawing.inputRail);
          updatePath(wire?.querySelector('[data-flow-rail="output"]'), drawing.outputRail);
          updatePath(wire?.querySelector("[data-flow-arrow]"), drawing.arrowPath);
          if (element.hasAttribute("data-flow-live")) {
            updatePath(wire?.querySelector('[data-flow-spark="input"]'), drawing.inputRail);
            updatePath(wire?.querySelector('[data-flow-spark="output"]'), drawing.outputRail);
          }
          continue;
        }
        const path = wire?.querySelector<SVGPathElement>("path");
        if (drawing.kind === "handoff") {
          const { base, fallback } = drawing;
          if (composerPath && path && row === lastHandoff) composerHandoff = { row: element, path, base, fallback };
          updatePath(path, row === lastHandoff && composerDrawing !== undefined ? base : fallback);
        } else {
          if (drawing.kind === "process") updateOffset(element, "--token-flow-process-x", drawing.offset);
          updatePath(path, drawing.path);
        }
      }
      updatePath(composerPath, composerDrawing);
    }

    const schedule = () => { if (!layoutFrame) layoutFrame = requestAnimationFrame(layout); };
    const onScroll = () => {
      if (scrollFrame || layoutFrame || !composerHandoff) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        const handoff = composerHandoff;
        if (layoutFrame || !handoff) return;
        const drawing = measureComposerPath(handoff.row.getBoundingClientRect());
        updatePath(handoff.path, drawing === undefined ? handoff.fallback : handoff.base);
        updatePath(composerPath, drawing);
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
  }, [enabled, contentRef, composerWireRef]);
}
