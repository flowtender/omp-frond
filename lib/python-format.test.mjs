import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parsePythonFormatSettings, resolvePythonFormatter, PYTHON_FORMAT_DEFAULTS } = await jiti.import("./python-format-shared.ts");
const { formatPythonSource, installedPythonFormatters } = await jiti.import("./python-formatter.ts");
const { formatEvalPython } = await jiti.import("./eval-code-format.ts");

const installed = await installedPythonFormatters(os.tmpdir());

test("stored settings fall back to off and automatic on anything unrecognised", () => {
  assert.deepEqual(parsePythonFormatSettings(null), PYTHON_FORMAT_DEFAULTS);
  assert.deepEqual(parsePythonFormatSettings("not json"), PYTHON_FORMAT_DEFAULTS);
  assert.deepEqual(parsePythonFormatSettings('{"enabled":"yes","formatter":"autopep8"}'), { enabled: false, formatter: "auto" });
  assert.deepEqual(parsePythonFormatSettings('{"enabled":true,"formatter":"black"}'), { enabled: true, formatter: "black" });
});

test("automatic prefers ruff, a named formatter is never substituted", () => {
  assert.equal(resolvePythonFormatter("auto", { ruff: true, black: true }), "ruff");
  assert.equal(resolvePythonFormatter("auto", { ruff: false, black: true }), "black");
  assert.equal(resolvePythonFormatter("black", { ruff: true, black: false }), null);
  assert.equal(resolvePythonFormatter("auto", { ruff: false, black: false }), null);
});

for (const formatter of ["ruff", "black"]) {
  test(`${formatter} splits statements and wraps by the project's own config`, { skip: !installed[formatter] }, async (t) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "omp-frond-pyfmt-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));

    assert.equal(await formatPythonSource("a=1; b=2", cwd, formatter), "a = 1\nb = 2");
    assert.equal(await formatPythonSource("a=1\n", cwd, formatter), "a = 1\n");

    const long = "x = foo(aaaaaaaa, bbbbbbbb, cccccccc)";
    assert.equal(await formatPythonSource(long, cwd, formatter), long);
    await writeFile(path.join(cwd, "pyproject.toml"), `[tool.${formatter}]\nline-length = 30\n`);
    const wrapped = await formatPythonSource(long, cwd, formatter);
    assert.ok(wrapped.includes("\n"), wrapped);
  });
}

test("invalid code is left for the caller to show as written", { skip: !installed.ruff && !installed.black }, async () => {
  assert.equal(await formatPythonSource("def broken(:\n  pass", os.tmpdir(), "auto"), null);
});

test("oversized source is never formatted", async () => {
  assert.equal(await formatPythonSource("a=1\n".repeat(30_000), os.tmpdir(), "auto"), null);
});

test("the browser never asks the server about percent commands or oversized cells", async (t) => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected request"); };
  t.after(() => { globalThis.fetch = original; });

  assert.equal(await formatEvalPython('%load "demo.py"', { formatter: "auto" }), '%load "demo.py"');
  assert.equal(await formatEvalPython("a=1\n".repeat(30_000), { formatter: "auto" }), "a=1\n".repeat(30_000));
  assert.equal(calls, 0);
});

test("the browser asks once per source and shows the source when the server fails", async (t) => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ formatted: "a = 1" });
  };
  t.after(() => { globalThis.fetch = original; });

  assert.equal(await formatEvalPython("a=1", { cwd: "/p", formatter: "auto" }), "a = 1");
  assert.equal(await formatEvalPython("a=1", { cwd: "/p", formatter: "auto" }), "a = 1");
  assert.equal(calls, 1);

  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.equal(await formatEvalPython("b=2", { formatter: "auto" }), "b=2");
});
