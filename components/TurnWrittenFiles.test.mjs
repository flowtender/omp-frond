import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { TurnWrittenFiles } = await jiti.import("./TurnWrittenFiles.tsx");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(TurnWrittenFiles, props)),
  );
}

test("renders one file-count trigger and labels duplicate basenames by full path", () => {
  const html = render({
    files: [{ filePath: "/abs/out/report.html" }, { filePath: "/abs/archive/report.html" }],
    onOpenFile() {},
  });
  assert.equal((html.match(/aria-haspopup=\"dialog\"/g) ?? []).length, 1);
  assert.match(html, /2 files written/);
  assert.match(html, /<dialog(?![^>]*\sopen(?:\s|=|>))/);
  assert.match(html, /aria-label="Open \/abs\/out\/report\.html"/);
  assert.match(html, /aria-label="Open \/abs\/archive\/report\.html"/);
});

test("renders nothing when no files were written", () => {
  assert.equal(render({ files: [], onOpenFile() {} }), "");
});
