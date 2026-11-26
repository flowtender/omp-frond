import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { loadMedia, svgMedia, MAX_MEDIA_BYTES } = await import("./form-media.ts");

// A 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "omp-frond-form-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a data: URI and a path from the session cwd load with their sniffed type", async (t) => {
  const cwd = await tempDir(t);
  await writeFile(join(cwd, "pixel.png"), Buffer.from(PNG_BASE64, "base64"));

  assert.equal((await loadMedia(`data:image/png;base64,${PNG_BASE64}`, cwd)).mime, "image/png");
  assert.equal((await loadMedia("pixel.png", cwd)).mime, "image/png");
});

test("a picture over the cap, or a file that is no image, is refused", async (t) => {
  const cwd = await tempDir(t);
  const large = join(cwd, "large.png");
  await writeFile(large, "");
  await truncate(large, MAX_MEDIA_BYTES + 1);
  await writeFile(join(cwd, "notes.txt"), "not a picture");

  await assert.rejects(loadMedia("large.png", cwd), /larger than 10 MiB/);
  await assert.rejects(loadMedia("notes.txt", cwd), /not a PNG, JPEG, GIF, WebP or SVG image/);
});

test("an svg sized only by its viewBox gets a namespace and that size", () => {
  const media = svgMedia('<svg viewBox="0 0 120 40"><rect width="10" height="10"/></svg>');
  const markup = new TextDecoder().decode(media.bytes);

  assert.equal(media.mime, "image/svg+xml");
  assert.match(markup, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="120" height="40" viewBox/);
});
