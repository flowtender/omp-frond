import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { writeFileAtomicSync } from "./atomic-file";
import { sessionPathKey } from "./session-path";
import { readSessionHeader } from "./session-reader";
import { SUBAGENT_META_TYPE } from "./subagents";

/** Only read the full transcript for a surviving child of a deleted session. */
export function* childrenToReparent(directory: string, isDeleted: (pathKey: string) => boolean) {
  let names: string[];
  try { names = readdirSync(directory); } catch (error) {
    // A transient session's cached path need not have a directory on disk yet.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(directory, name);
    if (isDeleted(sessionPathKey(path))) continue;
    let header;
    try {
      header = readSessionHeader(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") continue;
      throw error;
    }
    if (typeof header?.parentSession === "string" && isDeleted(sessionPathKey(header.parentSession))) {
      yield { path, parent: header.parentSession };
    }
  }
}

export function reparentSessionFile(path: string, parentSession: string | undefined, parentSessionId?: string): void {
  const original = readFileSync(path);
  const replacements: Buffer[] = [];
  let unchangedStart = 0;
  for (let start = 0; start < original.length;) {
    const newline = original.indexOf(0x0a, start);
    const end = newline < 0 ? original.length : newline;
    const jsonEnd = end > start && original[end - 1] === 0x0d ? end - 1 : end;
    if (start === 0) {
      const header = JSON.parse(original.toString("utf8", start, jsonEnd));
      header.parentSession = parentSession;
      replacements.push(Buffer.from(JSON.stringify(header)));
      unchangedStart = jsonEnd;
      if (!parentSessionId || !parentSession) break;
    } else {
      // Bulk deletion also updates the first subagent metadata entry. Other
      // lines, including malformed or unfinished entries, stay byte-for-byte.
      let entry;
      try { entry = JSON.parse(original.toString("utf8", start, jsonEnd)); } catch { /* not metadata */ }
      if (entry?.type === "custom" && entry.customType === SUBAGENT_META_TYPE &&
          entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)) {
        Object.assign(entry.data, { parentSessionId, parentSessionPath: parentSession });
        replacements.push(original.subarray(unchangedStart, start), Buffer.from(JSON.stringify(entry)));
        unchangedStart = jsonEnd;
        break;
      }
    }
    start = end + 1;
  }
  replacements.push(original.subarray(unchangedStart));
  writeFileAtomicSync(path, Buffer.concat(replacements));
}
