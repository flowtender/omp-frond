// omp's one-off compaction modes (`session/compact-modes.ts` in the SDK), kept here
// because the browser cannot bundle the SDK. compact-modes.test.mjs pins this table
// to the SDK's, so a mode omp adds or a focus rule it changes fails there.

export const COMPACT_MODES = ["soft", "remote", "snapcompact", "handoff"] as const;

export type CompactMode = (typeof COMPACT_MODES)[number];

/** What one compaction was asked for: omp's configured method order when `mode` is absent. */
export interface CompactRequest {
  mode?: CompactMode;
  /** Focus instructions for the summary. */
  focus?: string;
}

/** snapcompact archives history as images with no model-written summary, so omp rejects focus text for it. */
export function compactModeTakesFocus(mode: CompactMode | undefined): boolean {
  return mode !== "snapcompact";
}

function findCompactMode(token: string): CompactMode | undefined {
  const key = token.trim().toLowerCase();
  return COMPACT_MODES.find((mode) => mode === key);
}

/** Splits `/compact` arguments like omp does: a leading mode name, else everything is focus. */
export function splitCompactArgs(args: string): CompactRequest {
  const trimmed = args.trim();
  if (!trimmed) return {};
  const spaceIndex = trimmed.search(/\s/);
  const firstToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const mode = findCompactMode(firstToken);
  if (!mode) return { focus: trimmed };
  const focus = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
  return { mode, ...(focus ? { focus } : {}) };
}

/** The agent command that runs a compaction request. */
export function compactCommand({ mode, focus }: CompactRequest): Record<string, unknown> {
  return {
    type: "compact",
    ...(mode ? { mode } : {}),
    ...(focus ? { customInstructions: focus } : {}),
  };
}
