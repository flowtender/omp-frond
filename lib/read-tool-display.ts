export interface ReadToolPreview {
  text: string;
  markdown: boolean;
  url?: string;
  contentType?: string;
  method?: string;
  notes?: string;
  hash?: string;
  sourcePath?: string;
}

function isMarkdown(contentType: string | undefined): boolean {
  return /^text\/(?:markdown|x-markdown)(?:\s*;|$)/i.test(contentType ?? "");
}

export function readToolPreview(text: string, path: unknown, details: unknown, renderMarkdown: boolean): ReadToolPreview | null {
  const info: Record<string, unknown> = typeof details === "object" && details !== null ? details as Record<string, unknown> : {};
  if (typeof path === "string" && /^(?:https?:\/\/|www\.)/i.test(path)) {
    // Only strip a complete reader envelope. Raw selectors and truncated headers
    // can contain arbitrary text, not metadata supplied by the reader.
    if (!renderMarkdown || info.raw === true) return null;
    const envelope = /^URL: (https?:\/\/[^\r\n]+)\r?\nContent-Type: ([^\r\n]+)\r?\nMethod: ([^\r\n]+)\r?\n(?:Notes: ([^\r\n]+)\r?\n)?\r?\n---\r?\n\r?\n/i.exec(text);
    if (!envelope || (info.kind !== "url" && envelope[1] !== path)) return null;
    const [header, url, contentType, method, notes] = envelope;
    const markdown = isMarkdown(contentType) || /^(?:native|trafilatura|parallel|firecrawl|jina|feed|alternate-feed|markit)$/.test(method);
    return { text: text.slice(header.length), markdown, url, contentType, method, notes };
  }

  const source = typeof info.resolvedPath === "string" ? info.resolvedPath : path;
  const markdown = renderMarkdown && (isMarkdown(typeof info.contentType === "string" ? info.contentType : undefined)
    || (typeof source === "string" && (/^skill:\/\//i.test(source) || /\.(?:md|mdx|markdown)(?::[^/\\]*)?$/i.test(source))));
  const display = info.displayContent;
  const displayText = typeof display === "object" && display !== null && "text" in display && typeof display.text === "string"
    ? display.text : undefined;
  const prefixed = info.raw !== true && info.rowPrefixes === true;
  if (!markdown && displayText === undefined && !prefixed) return null;

  const provenance = info.raw !== true ? /^\[Skill file: ([^\r\n]+)\]\r?\n/.exec(text) : null;
  const content = provenance ? text.slice(provenance[0].length) : text;
  const snapshot = prefixed ? /^\[([^\r\n]+)#([0-9A-F]{4})\]\r?\n/i.exec(content) : null;
  // The SDK's display body also excludes model-only notices after the excerpt.
  const body = displayText ?? (prefixed
    ? (snapshot ? content.slice(snapshot[0].length) : content).replace(/^\d+(?:-\d+)?[:|]/gm, "")
    : content);
  if (!markdown && body === text) return null;
  return {
    markdown,
    hash: snapshot?.[2],
    sourcePath: provenance?.[1] ?? (snapshot && snapshot[1] !== path && snapshot[1] !== source ? snapshot[1] : undefined),
    text: body,
  };
}
