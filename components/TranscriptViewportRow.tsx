import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const ROW_OVERSCAN = "700px 0px";
const ESTIMATED_ROW_HEIGHT = 96;

type ObserveRow = (entry: IntersectionObserverEntry) => void;
const viewports = new WeakMap<Element, { observer: IntersectionObserver; rows: WeakMap<Element, ObserveRow> }>();

function observeRow(root: Element, row: Element, update: ObserveRow) {
  let viewport = viewports.get(root);
  if (!viewport) {
    const rows = new WeakMap<Element, ObserveRow>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) rows.get(entry.target)?.(entry);
    }, { root, rootMargin: ROW_OVERSCAN });
    viewport = { observer, rows };
    viewports.set(root, viewport);
  }
  const { observer, rows } = viewport;
  rows.set(row, update);
  observer.observe(row);
  return () => {
    rows.delete(row);
    observer.unobserve(row);
  };
}

/** Keep row positions in normal flow, but only mount the transcript near the scrollport. */
export function TranscriptViewportRow({ pinned, render }: { pinned?: boolean; render: () => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [{ near, height }, setWindow] = useState({ near: false, height: ESTIMATED_ROW_HEIGHT });
  const [focused, setFocused] = useState(false);
  const [unfoldedByReader, setUnfoldedByReader] = useState(false);
  const keepMounted = pinned || focused || unfoldedByReader;
  const mounted = keepMounted || near;

  useLayoutEffect(() => {
    const row = ref.current;
    const root = row?.closest("[data-chat-transcript-scroll]");
    if (keepMounted || !row || !root || typeof IntersectionObserver === "undefined") {
      // Keep the content until the observer gets a fresh position after a jump.
      setWindow((window) => window.near ? window : { ...window, near: true });
      return;
    }
    return observeRow(root, row, (entry) => {
      const near = entry.isIntersecting;
      const measured = !near && !row.hasAttribute("data-transcript-gap") ? entry.boundingClientRect.height : undefined;
      setWindow((window) => {
        const height = measured ?? window.height;
        return near === window.near && height === window.height ? window : { near, height };
      });
    });
  }, [keepMounted]);

  return (
    <div
      ref={ref}
      className="transcript-viewport-row"
      data-transcript-gap={mounted ? undefined : ""}
      style={mounted ? undefined : { height }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      onClickCapture={(event) => {
        // Explicitly opened content can hold fetched thinking, an inner scroll, or a form.
        if (event.target instanceof Element && event.target.closest('[aria-expanded="false"], summary')) {
          setUnfoldedByReader(true);
        }
      }}
    >
      {mounted && render()}
    </div>
  );
}
