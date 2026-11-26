import { randomUUID } from "crypto";
import { chmodSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  writeFileAtomicSync(path, contents, 0o600);
}

/** With no mode, replace an existing file through symlinks and keep its permissions. */
export function writeFileAtomicSync(path: string, contents: string | Uint8Array, mode?: number): void {
  const preserveMode = mode === undefined;
  if (preserveMode) {
    path = realpathSync(path);
    mode = statSync(path).mode & 0o7777;
  }
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode,
      flush: true,
    });
    // Creation applies the umask; restore the original bits before publication.
    if (preserveMode && mode !== undefined) chmodSync(tempPath, mode);
    renameSync(tempPath, path);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}
