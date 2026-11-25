import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types";

export const DEFAULT_CUSTOM_UI_COLUMNS = 92;
export const DEFAULT_CUSTOM_UI_ROWS = 40;

/**
 * The `ExtensionUiHost` extension widgets and `ctx.ui.custom` views receive: a
 * fixed-size grid, since the browser draws their rows at one width. There is
 * no terminal to hand over, so `suspend` runs its callback in place.
 */
export function createHeadlessExtensionUiHost(
  requestRender: () => void,
  columns = DEFAULT_CUSTOM_UI_COLUMNS,
  rows = DEFAULT_CUSTOM_UI_ROWS,
): ExtensionUiHost {
  const size = Object.freeze({ columns, rows });
  return Object.freeze({
    requestRender,
    size: () => size,
    suspend: <R>(run: () => Promise<R>) => run(),
  });
}
