"use client";

import { Children, createContext, memo, useContext, useMemo, useState, type ComponentProps, type MouseEvent } from "react";
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
const StreamingProseContext = createContext(false);
const FADE_SPREAD_MS = 90;
const FADE_MS = 70;
const MAX_FADING_CHARS = 192;
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

interface ProseBatch {
  start: number;
  glyphs: string[];
  length: number;
}

function FadingProse({ text }: { text: string }) {
  const [previous, setPrevious] = useState("");
  const [batch, setBatch] = useState<ProseBatch | null>(null);
  if (text !== previous) {
    const suffix = text.slice(previous.length);
    const append = graphemes && suffix && text.startsWith(previous)
      // A new combining mark may extend the last visible grapheme.
      && (previous.length === 0 || graphemes.segment(text).containing(previous.length)?.index === previous.length);
    setPrevious(text);
    const glyphs: string[] = [];
    if (append) {
      const groupSize = Math.ceil(suffix.length / MAX_FADING_CHARS);
      let index = 0;
      for (const { segment } of graphemes.segment(suffix)) {
        const group = Math.floor(index++ / groupSize);
        glyphs[group] = (glyphs[group] ?? "") + segment;
      }
    }
    setBatch(glyphs.length ? { start: previous.length, glyphs, length: suffix.length } : null);
  }
  if (!batch) return text;
  const { start, glyphs, length } = batch;
  return <>{text.slice(0, start)}
    <span key={start}>{glyphs.map((glyph, index) => (
      <span key={index} className="streaming-prose-glyph"
        onAnimationEnd={index === glyphs.length - 1 ? () => setBatch((current) => current === batch ? null : current) : undefined}
        style={{
          animationDuration: `${FADE_MS}ms`,
          animationDelay: `${index * FADE_SPREAD_MS / Math.max(1, glyphs.length - 1)}ms`,
        }}>{glyph}</span>
    ))}</span>
    {text.slice(start + length)}
  </>;
}

function ProseParagraph({ node: _node, children, ...props }: ComponentProps<"p"> & ExtraProps) {
  const animate = useContext(StreamingProseContext);
  return <p {...props}>{animate ? Children.map(children, (child) => (
    typeof child === "string" ? <FadingProse text={child} /> : child
  )) : children}</p>;
}

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
  const animateProse = useContext(ChatAnimationsContext) > 0 && Boolean(isStreaming);
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
    p: ProseParagraph,
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
          {children}
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
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }
      if (href?.startsWith("#")) {
        // An in-page link: never a second tab of Pi Web.
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a href={href} {...props} onClick={jumpToMarkdownFragment}>
              {children}
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
              {children}
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
            {children}
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
    <StreamingProseContext.Provider value={animateProse}>
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
