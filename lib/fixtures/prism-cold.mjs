import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { refractor } from "refractor/core";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { createElement } = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { CodeBlock } = await jiti.import("@/components/MermaidBlock");
const { prismLanguagesLoaded, loadPrismLanguages } = await jiti.import("@/lib/prism-languages");
const render = () => renderToStaticMarkup(createElement(I18nProvider, null,
  createElement(CodeBlock, { lang: "ts", code: "const x = 1;\nlet y = 2;" })));

assert.equal(prismLanguagesLoaded(), false);
assert.equal(refractor.registered("typescript"), false);
const plain = render();
assert.doesNotMatch(plain, /class="token/);
assert.match(plain, /const x = 1;/);
assert.equal(plain.match(/react-syntax-highlighter-line-number/g)?.length, 2);
const first = loadPrismLanguages();
assert.equal(loadPrismLanguages(), first);
await first;
assert.equal(prismLanguagesLoaded(), true);
for (const language of ["typescript", "ts", "tsx", "javascript", "js", "bash", "sh", "shell", "python", "py", "json", "yaml", "yml", "css", "markup", "html", "diff", "rust", "go"]) {
  assert.ok(refractor.registered(language), language);
}
assert.match(render(), /class="token keyword">const</);
