import { stat } from "fs/promises";
import { resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isFileManagerSupported, isLoopbackHost, launchFileManager } from "@/lib/open-in-file-manager";
import { workerWorkspaceRoot } from "@/lib/worker-workspace";
import { WORKER_BROWSER_HOST_HEADER } from "@/worker/protocol";

/** Whether this request may raise a file-manager window on the server. */
function availabilityFor(request: Request): { supported: boolean; reason: string | null } {
  if (workerWorkspaceRoot) return { supported: false, reason: "remote" };
  if (!isLoopbackHost(request.headers.get(WORKER_BROWSER_HOST_HEADER))) return { supported: false, reason: "remote" };
  if (!isFileManagerSupported(process.platform)) return { supported: false, reason: "unsupported-platform" };
  return { supported: true, reason: null };
}

/** Lets the sidebar pick the button label and disable it when unavailable. */
export async function GET(request: Request) {
  const { supported, reason } = availabilityFor(request);
  return Response.json({ supported, reason, platform: process.platform });
}

/** Opens the session workspace in the OS file manager. */
export async function POST(request: Request) {
  try {
    const { supported, reason } = availabilityFor(request);
    if (!supported) {
      return Response.json({ error: reason }, { status: 403 });
    }

    const body = await request.json() as { cwd?: unknown };
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return Response.json({ error: "cwd-required" }, { status: 400 });
    }
    const target = resolve(body.cwd);
    // Authorize before touching the path, so a location outside the allowed
    // roots answers 403 whether or not it exists.
    const roots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(target, roots)) {
      return Response.json({ error: "access-denied" }, { status: 403 });
    }
    if (!(await stat(target)).isDirectory()) {
      return Response.json({ error: "not-a-directory" }, { status: 400 });
    }

    await launchFileManager(target);
    return Response.json({ opened: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
