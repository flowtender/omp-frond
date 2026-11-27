import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { loadPrismLanguages } = await jiti.import("@/lib/prism-languages");
const { parseUnifiedPatch } = await jiti.import("@/lib/patch");
const { highlightDiffFile, canHighlightDiff } = await jiti.import("@/lib/diff-syntax");
const { PatchDiffFiles } = await jiti.import("./MessageView.tsx");

const patch = `--- a/demo.ts
+++ b/demo.ts
@@ -1,4 +1,4 @@
 /* comment
-old text
+new text
  ends */
 const value = 1;
@@ -20,1 +20,1 @@
-oldCall();
+newCall();
`;
const files = parseUnifiedPatch(patch);
const file = files[0];
const lines = file.rows.filter((row) => row.type === "line");
const render = (layout, extra = {}) => renderToStaticMarkup(React.createElement(I18nProvider, null,
  React.createElement(PatchDiffFiles, { files, layout, ...extra })));

await loadPrismLanguages();

test("tokenizes entire hunks on each side and preserves all source text", () => {
  const tokens = highlightDiffFile(file, "typescript");
  for (const row of lines) for (const cell of [row.left, row.right]) {
    if (cell.type !== "empty") assert.equal(tokens.get(cell).map((token) => token.text).join(""), cell.text);
  }
  assert.match(tokens.get(lines[1].left)[0].className, /comment/);
  assert.match(tokens.get(lines[1].right)[0].className, /comment/);
  assert.doesNotMatch(tokens.get(lines[4].right)[0].className, /comment/);
});

test("split and stacked views retain change markers and syntax", () => {
  for (const layout of ["split", "stacked"]) {
    const html = render(layout);
    assert.match(html, /token comment/);
    assert.match(html, /old text/);
    assert.match(html, /new text/);
    assert.match(html, /#f87171/);
    assert.match(html, /#22c55e/);
    assert.match(html, /⋯/);
  }
});

test("streaming previews highlight source before the patch finishes", () => {
  for (const layout of ["split", "stacked"]) {
    const html = render(layout, { streaming: true });
    assert.match(html, /token comment[^>]*>old text/);
    assert.match(html, /token comment[^>]*>new text/);
  }
});

test("unknown languages and oversized patches stay plain", () => {
  const large = parseUnifiedPatch(`--- a/demo.ts\n+++ b/demo.ts\n@@ -0,0 +1 @@\n+const value = "${"x".repeat(16_000)}";\n`);
  assert.equal(canHighlightDiff(large, true), false);
  assert.equal(canHighlightDiff(large, false), true);
  assert.equal(canHighlightDiff([{ rows: [{ type: "line", left: { text: "x".repeat(100001) }, right: { text: "" } }] }], false), false);
  assert.equal(highlightDiffFile(file, "not-a-language").get(lines[0].left), undefined);
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(PatchDiffFiles, { files: large, layout: "stacked", streaming: true })));
  assert.doesNotMatch(html, /token keyword/);
  assert.match(html, /const value/);
});

test("headerless edit patches use the target path and JSON-specific class", () => {
  const headerless = parseUnifiedPatch('@@ -1,1 +1,1 @@\n-{"old": 1}\n+{"new": 2}\n');
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(PatchDiffFiles, { files: headerless, layout: "stacked", targetPath: "config.json" })));
  assert.match(html, /omp-syntax language-json/);
  assert.match(html, /token property/);
});
