import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const settingsConfigCss = await readFile(new URL("./SettingsConfig.module.css", import.meta.url), "utf8");
// The fork has no login page: provider OAuth completes in-process (server
// registry + the paste panel), so upstream's `safeLoginDestination()` page-side
// guard has no counterpart — pin that the flow stays navigation-free instead.
const loginRouteSource = await readFile(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url), "utf8");

test("project trust stacks above the unified settings dialog", () => {
  const zIndex = (source, selector) => Number(source.match(new RegExp(`\\.${selector}(?:,\\s*\\.[\\w-]+)* \\{[^}]*z-index: (\\d+);`))?.[1]);
  assert.ok(zIndex(cssSource, "project-trust-backdrop") > zIndex(settingsConfigCss, "backdrop"));
});

test("provider login never navigates the browser to a caller-supplied destination", () => {
  assert.doesNotMatch(loginRouteSource, /Response\.redirect\(|location\.assign|location\.href\s*=/);
  assert.doesNotMatch(loginRouteSource, /destination/);
});
