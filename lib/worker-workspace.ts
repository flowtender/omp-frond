import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";

function readWorkspaceRoot(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) throw new Error("OMP_FROND_WORKER_WORKSPACE must name an absolute directory.");
  const root = realpathSync(value);
  if (!statSync(root).isDirectory()) throw new Error("The worker workspace is not a directory.");
  return root;
}

export const workerWorkspaceRoot = readWorkspaceRoot(process.env.OMP_FROND_WORKER_WORKSPACE);
export const workerWorkspaceRoots = workerWorkspaceRoot ? new Set([workerWorkspaceRoot]) : undefined;

export function isWorkerWorkspacePath(target: string): boolean {
  return !workerWorkspaceRoots
    || (isPathWithinRoots(target, workerWorkspaceRoots) && isExistingPathWithinRoots(target, workerWorkspaceRoots));
}
