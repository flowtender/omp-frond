import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const settingsConfigCss = await readFile(new URL("./SettingsConfig.module.css", import.meta.url), "utf8");

test("project trust stacks above the unified settings dialog", () => {
  const zIndex = (source, selector) => Number(source.match(new RegExp(`\\.${selector}(?:,\\s*\\.[\\w-]+)* \\{[^}]*z-index: (\\d+);`))?.[1]);
  assert.ok(zIndex(cssSource, "project-trust-backdrop") > zIndex(settingsConfigCss, "backdrop"));
});
