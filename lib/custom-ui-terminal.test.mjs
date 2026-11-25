import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./custom-ui-terminal.ts");
}

test("headless extension UI host reports a stable size", async () => {
  const { createHeadlessExtensionUiHost, DEFAULT_CUSTOM_UI_COLUMNS, DEFAULT_CUSTOM_UI_ROWS } = await loadSubject();
  const host = createHeadlessExtensionUiHost(() => {});

  assert.deepEqual(host.size(), { columns: DEFAULT_CUSTOM_UI_COLUMNS, rows: DEFAULT_CUSTOM_UI_ROWS });
  assert.equal(Object.isFrozen(host), true);
});

test("headless extension UI host forwards render requests and runs suspended work in place", async () => {
  const { createHeadlessExtensionUiHost } = await loadSubject();
  let renders = 0;
  const host = createHeadlessExtensionUiHost(() => { renders += 1; }, 80, 24);
  const rowsView = {
    render: (width) => [`${width}:${host.size().columns}x${host.size().rows}`],
  };

  assert.deepEqual(rowsView.render(80), ["80:80x24"]);
  host.requestRender();
  assert.equal(renders, 1);
  assert.equal(await host.suspend(async () => "edited"), "edited");
});
