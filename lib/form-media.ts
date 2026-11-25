/**
 * Pictures of an ask form, as bytes plus a MIME type for the browser to draw.
 * The browser renders SVG itself, so nothing here rasterizes.
 *
 * omp 19.2 has no exported loader for this: its form's own (`ui/forms/html-form/media.ts`)
 * registers pi-tui blobs and rasterizes SVG for the terminal. What omp-web adds is
 * what the SDK lacks: the size cap and the fetch timeout.
 */
import { resolveReadPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";

/** An image's bytes and MIME type. */
export interface Media {
  bytes: Uint8Array;
  mime: string;
}

/** Largest picture loaded. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
/** Longest a remote picture may take to arrive. */
const FETCH_TIMEOUT_MS = 10_000;
const SVG_MIME = "image/svg+xml";
const TOO_LARGE = `larger than ${MAX_MEDIA_BYTES >> 20} MiB`;

/**
 * Load an `<img src>`: an `http(s):` URL, a `data:` URI, or a path resolved as the
 * read tool resolves it from `cwd`.
 *
 * @throws {Error} the source cannot be read, exceeds {@link MAX_MEDIA_BYTES},
 * times out, or is not a PNG, JPEG, GIF, WebP or SVG image.
 */
export async function loadMedia(src: string, cwd: string, signal?: AbortSignal): Promise<Media> {
  const bytes = await readSource(src, cwd, signal);
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error(TOO_LARGE);
  const raster = parseImageMetadata(bytes.subarray(0, 64));
  if (raster) return { bytes, mime: raster.mimeType };
  const text = new TextDecoder().decode(bytes);
  if (/<svg[\s>]/i.test(text.slice(0, 4096))) return svgMedia(text);
  throw new Error("not a PNG, JPEG, GIF, WebP or SVG image");
}

/**
 * An `<svg>` as a standalone document: the SVG namespace added when missing, and a
 * drawing sized only by its `viewBox` given that size, since `<img>` drops a drawing without one.
 */
export function svgMedia(markup: string): Media {
  const open = /<svg\b[^>]*>/i.exec(markup)?.[0] ?? "";
  const added: string[] = [];
  if (open && !/\bxmlns\s*=/i.test(open)) added.push('xmlns="http://www.w3.org/2000/svg"');
  const box = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(open);
  if (box && !/\swidth\s*=/i.test(open) && !/\sheight\s*=/i.test(open)) added.push(`width="${box[1]}"`, `height="${box[2]}"`);
  const sized = added.length > 0 ? markup.replace(/<svg\b/i, `<svg ${added.join(" ")}`) : markup;
  return { bytes: new TextEncoder().encode(sized), mime: SVG_MIME };
}

async function readSource(src: string, cwd: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (/^data:/i.test(src)) return decodeDataUri(src);
  if (/^https?:\/\//i.test(src)) {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetch(src, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_MEDIA_BYTES) throw new Error(TOO_LARGE);
    return new Uint8Array(await response.arrayBuffer());
  }
  const file = Bun.file(resolveReadPath(src, cwd));
  if (file.size > MAX_MEDIA_BYTES) throw new Error(TOO_LARGE);
  return new Uint8Array(await file.arrayBuffer());
}

/** The payload of a `data:` URI; base64 when marked so, else percent-encoded text. */
function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  if (comma === -1) throw new Error("malformed data: URI");
  const payload = uri.slice(comma + 1);
  if (/;base64$/i.test(uri.slice(5, comma))) return Uint8Array.fromBase64(payload.replace(/\s+/g, ""));
  return new TextEncoder().encode(decodeURIComponent(payload));
}
