"use client";

import { Children, createContext, createElement, memo, useCallback, useContext, useMemo, useState, type ComponentProps, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { isAudioPath, isVideoPath } from "@/lib/file-types";
import { isExternalMarkdownHref, jumpToMarkdownFragment, markdownAppUrlTransform, markdownDocumentRehypePlugins, markdownRehypePlugins, markdownRemarkPlugins, markdownUrlTransform, markdownUserRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { ImagePreview } from "./ImagePreview";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { ChatAnimationsContext } from "@/hooks/useChatAnimations";

const MarkdownLinkContext = createContext(false);
const StreamingProseContext = createContext<{ duration: number; clock: ProseClock } | null>(null);
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

interface ProseClock {
  frame: number | null;
  elapsed: number;
}

interface ProseBatch {
  start: number;
  end: number;
  glyphs: string[];
}

const ProseFade = memo(function ProseFade({ batch, duration, clock, settle }: {
  batch: ProseBatch;
  duration: number;
  clock: ProseClock;
  settle: (end: number) => void;
}) {
  const attach = useCallback((element: HTMLSpanElement | null) => {
    if (!element) return;
    // All text runs committed in the same browser frame share the chunk's timing.
    const time = document.timeline?.currentTime;
    const frame = typeof time === "number" ? time : performance.now();
    if (clock.frame !== frame) {
      clock.elapsed = clock.frame === null ? 0 : frame - clock.frame;
      clock.frame = frame;
    }
    element.style.setProperty("--prose-fade-spread", `${Math.min(duration, Math.max(0, clock.elapsed))}ms`);
  }, [clock, duration]);
  const last = batch.glyphs.length - 1;
  return <span ref={attach} style={{ "--prose-fade-duration": `${duration}ms` } as CSSProperties}>
    {batch.glyphs.map((glyph, index) => (
      <span key={index} className="streaming-prose-glyph"
        onAnimationEnd={index === last ? () => settle(batch.end) : undefined}
        style={{ "--prose-fade-offset": last === 0 ? 0 : index / last - 1 } as CSSProperties}>{glyph}</span>
    ))}
  </span>;
});

function FadingProse({ text, duration, clock }: { text: string; duration: number; clock: ProseClock }) {
  const [previous, setPrevious] = useState("");
  const [batches, setBatches] = useState<ProseBatch[]>([]);
  const settle = useCallback((end: number) => setBatches((current) => current.filter((batch) => batch.end > end)), []);
  if (text !== previous) {
    const suffix = text.slice(previous.length);
    const append = suffix && text.startsWith(previous)
      // A new combining mark may extend the last visible grapheme.
      && (!graphemes || previous.length === 0 || graphemes.segment(text).containing(previous.length)?.index === previous.length);
    setPrevious(text);
    setBatches(append ? [...batches, {
      start: previous.length,
      end: text.length,
      glyphs: graphemes ? Array.from(graphemes.segment(suffix), ({ segment }) => segment) : Array.from(suffix),
    }] : []);
  }
  if (!batches.length) return text;
  return <>{text.slice(0, batches[0].start)}
    {batches.map((batch) => <ProseFade key={batch.start} batch={batch} duration={duration} clock={clock} settle={settle} />)}
    {text.slice(batches[batches.length - 1].end)}
  </>;
}

function ProseChildren({ children }: { children: ReactNode }) {
  const motion = useContext(StreamingProseContext);
  return motion ? Children.map(children, (child) => (
    typeof child === "string" ? <FadingProse text={child} {...motion} /> : child
  )) : children;
}

function proseTag(tag: string) {
  return function ProseElement({ node: _node, children, ...props }: { children?: ReactNode } & ExtraProps) {
    return createElement(tag, props, <ProseChildren>{children}</ProseChildren>);
  };
}

const proseTags = {
  p: proseTag("p"), li: proseTag("li"),
  h1: proseTag("h1"), h2: proseTag("h2"), h3: proseTag("h3"),
  h4: proseTag("h4"), h5: proseTag("h5"), h6: proseTag("h6"),
  em: proseTag("em"), strong: proseTag("strong"), del: proseTag("del"),
  td: proseTag("td"), th: proseTag("th"),
};

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** A document reader's own links: relative paths and `#headings` stay in the reader. */
  onNavigateLink?: (href: string) => void;
  /** Render every line ending as a line break, for text the user typed. */
  keepLineBreaks?: boolean;
}

function MarkdownImage({
  src,
  alt,
  cwd,
  ...props
}: ComponentProps<"img"> & ExtraProps & { cwd?: string }) {
  const insideLink = useContext(MarkdownLinkContext);
  delete props.node;
  const href = typeof src === "string" ? src : undefined;
  const filePath = href ? resolveLocalFileHref(href, cwd) : null;
  const mediaSrc = filePath
    ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
    : href;
  // `![](take.wav)` is how a model shows a sound or clip it made, and an <img>
  // cannot play it. The file API already streams both with range requests.
  const mediaPath = filePath ?? href?.split(/[?#]/, 1)[0] ?? "";
  const label = alt?.trim() ? alt : undefined;
  if (isAudioPath(mediaPath)) {
    return <audio controls preload="metadata" src={mediaSrc} aria-label={label} />;
  }
  if (isVideoPath(mediaPath)) {
    return <video controls playsInline preload="metadata" src={mediaSrc} aria-label={label} />;
  }
  // Dynamic local paths are served directly by the file API.
  // eslint-disable-next-line @next/next/no-img-element
  const image = <img src={mediaSrc} alt={alt ?? ""} loading="lazy" {...props} />;
  if (!mediaSrc || insideLink) return image;
  return (
    <ImagePreview src={mediaSrc} alt={alt ?? ""} className="markdown-image">
      {image}
    </ImagePreview>
  );
}

interface MarkdownBlockProps {
  markdown: string;
  remarkPlugins: typeof markdownRemarkPlugins;
  urlTransform: typeof markdownUrlTransform;
  rehypePlugins: typeof markdownRehypePlugins;
  components: Components;
}

/** One parse; skipped while its text and renderers stay the same. */
const MarkdownBlock = memo(function MarkdownBlock({ markdown, remarkPlugins, urlTransform, rehypePlugins, components }: MarkdownBlockProps) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  );
});

export const MarkdownBody = memo(function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, onNavigateLink, keepLineBreaks }: MarkdownBodyProps) {
  const duration = useContext(ChatAnimationsContext);
  const [clock] = useState<ProseClock>(() => ({ frame: null, elapsed: 0 }));
  const proseMotion = useMemo(() => isStreaming && duration > 0 ? { duration, clock } : null, [isStreaming, duration, clock]);
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  // A streaming reply grows by a few characters per chunk; parsing all of it
  // each time made a long reply quadratic. Its finished blocks keep their
  // parse and only the last is parsed again. A finished message is one block.
  const blocks = useMemo(
    () => (isStreaming ? splitMarkdownBlocks(normalizedMarkdown) : [normalizedMarkdown]),
    [isStreaming, normalizedMarkdown],
  );
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    ...(isStreaming ? proseTags : {}),
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return (
            <MermaidBlock
              code={raw.replace(/\n$/, "")}
              isStreaming={isStreaming}
              defaultPreview
            />
          );
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} />;
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          <ProseChildren>{children}</ProseChildren>
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      if (onNavigateLink && href && !isExternalMarkdownHref(href)) {
        // No href: a middle-click or "Open in new tab" would load the path on the app's own URL.
        const navigate = () => onNavigateLink(href);
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a {...props} role="link" tabIndex={0} onClick={navigate} onKeyDown={(event) => { if (event.key === "Enter") navigate(); }}>
              <ProseChildren>{children}</ProseChildren>
            </a>
          </MarkdownLinkContext.Provider>
        );
      }
      if (href?.startsWith("#")) {
        // An in-page link: never a second tab of Pi Web.
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a href={href} {...props} onClick={jumpToMarkdownFragment}>
              <ProseChildren>{children}</ProseChildren>
            </a>
          </MarkdownLinkContext.Provider>
        );
      }
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a href={href} {...props} target="_blank" rel="noopener noreferrer">
              <ProseChildren>{children}</ProseChildren>
            </a>
          </MarkdownLinkContext.Provider>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!shouldOpenLocalFileInApp(event)) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath, parsePdfPageFragment(href) ?? undefined);
      };

      return (
        <MarkdownLinkContext.Provider value={true}>
          <a href={href} {...props} onClick={handleClick}>
            <ProseChildren>{children}</ProseChildren>
          </a>
        </MarkdownLinkContext.Provider>
      );
    },
    img(props) {
      return <MarkdownImage cwd={cwd} {...props} />;
    },
    ol({ node, start, style, ...props }) {
      // An outside marker wider than the list's left padding is clipped by
      // .markdown-body's overflow-x, so the padding follows the largest number.
      const items = node?.children.filter((child) => child.type === "element" && child.tagName === "li").length ?? 0;
      const digits = String(Math.abs((start ?? 1) + Math.max(items, 1) - 1)).length;
      return <ol start={start} style={{ ...style, ["--ol-marker-digits" as string]: Math.max(digits, 2) }} {...props} />;
    },
    table({ children }) {
      // The frame draws the border; the scroller inside it fades its scrolled
      // edges, which on the bordered box would fade the border too.
      return (
        <div className="markdown-table-frame">
          <div className="markdown-table-wrap">
            <table>{children}</table>
          </div>
        </div>
      );
    },
  }), [cwd, isStreaming, onOpenFile, onNavigateLink]);

  return (
    <StreamingProseContext.Provider value={proseMotion}>
      <div className={["markdown-body", className].filter(Boolean).join(" ")}>
        {blocks.map((block, index) => (
        <MarkdownBlock
          key={index}
          markdown={block}
          remarkPlugins={keepLineBreaks ? markdownUserRemarkPlugins : markdownRemarkPlugins}
          urlTransform={onOpenFile ? markdownUrlTransform : markdownAppUrlTransform}
          rehypePlugins={onNavigateLink ? markdownDocumentRehypePlugins : markdownRehypePlugins}
          components={components}
        />
        ))}
      </div>
    </StreamingProseContext.Provider>
  );
});
