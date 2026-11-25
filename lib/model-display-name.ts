/**
 * The name omp's TUI status line shows for a model: the catalog name with a
 * leading "Claude " dropped (pi-tui `modelDisplayName()` in
 * `src/status-line/segments.ts`, not exported). omp's model data has no short
 * name of its own; check again on SDK upgrades whether one exists or the TUI's
 * rule has grown, and follow it.
 */
export function compactModelName(name: string): string {
  return name.startsWith("Claude ") ? name.slice("Claude ".length) : name;
}
