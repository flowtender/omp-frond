import { refractor } from "refractor/core";
import type { RootContent } from "hast";
import type { SplitDiffCell, SplitDiffFile } from "./patch";

export interface DiffToken {
  text: string;
  className: string;
}

/** Tokenize each contiguous hunk as a complete old and new source fragment. */
export function highlightDiffFile(file: SplitDiffFile, language: string): WeakMap<SplitDiffCell, DiffToken[]> {
  const result = new WeakMap<SplitDiffCell, DiffToken[]>();
  if (!refractor.registered(language)) return result;

  let left: SplitDiffCell[] = [];
  let right: SplitDiffCell[] = [];
  const highlightSide = (cells: SplitDiffCell[]) => {
    if (!cells.length) return;
    const lines: DiffToken[][] = [[]];
    const visit = (node: RootContent, classes: string) => {
      if (node.type === "text") {
        const parts = node.value.split("\n");
        parts.forEach((text, index) => {
          if (index) lines.push([]);
          if (text) lines[lines.length - 1].push({ text, className: classes });
        });
      } else if (node.type === "element") {
        const own = node.properties.className?.join(" ");
        const nested = own ? (classes ? `${classes} ${own}` : own) : classes;
        node.children.forEach((child) => visit(child, nested));
      }
    };
    refractor.highlight(cells.map((cell) => cell.text).join("\n"), language).children.forEach((node) => visit(node, ""));
    cells.forEach((cell, index) => result.set(cell, lines[index] ?? []));
  };
  const flush = () => {
    highlightSide(left);
    highlightSide(right);
    left = [];
    right = [];
  };
  for (const row of file.rows) {
    if (row.type === "gap" || (row.type === "hunk" && row.text.startsWith("@@"))) {
      flush();
    } else if (row.type === "line") {
      if (row.left.type !== "empty") left.push(row.left);
      if (row.right.type !== "empty") right.push(row.right);
    }
  }
  flush();
  return result;
}

/** Avoid loading grammars or tokenizing a large/streaming patch. */
export function canHighlightDiff(files: SplitDiffFile[], streaming: boolean): boolean {
  if (streaming) return false;
  let size = 0;
  for (const file of files) {
    for (const row of file.rows) {
      if (row.type === "line") {
        size += row.left.text.length + row.right.text.length + 2;
        if (size > 100_000) return false;
      }
    }
  }
  return true;
}
