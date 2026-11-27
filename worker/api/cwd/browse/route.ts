import { stat } from "fs/promises";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  createDirectory,
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  normalizeDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";
import { isWorkerWorkspacePath, workerWorkspaceRoot } from "@/lib/worker-workspace";

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
export async function GET(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get("path")?.trim();

    if (!workerWorkspaceRoot && shouldShowWindowsDrivePicker(requested)) {
      return Response.json({
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      });
    }

    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return Response.json({ error: "Directory does not exist" }, { status: 404 });
    }

    if (!isWorkerWorkspacePath(resolved)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return Response.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const directories = await listDirectories(resolved);

    return Response.json({
      path: resolved,
      parentPath: resolved === workerWorkspaceRoot ? null : getParentDirectory(resolved),
      directories: workerWorkspaceRoot ? directories.filter(({ path }) => isWorkerWorkspacePath(path)) : directories,
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/cwd/browse  body: { path: string, name: string }
// Creates one direct child of the currently browsed directory.
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await request.json() as { path?: unknown; name?: unknown };
    const parentPath = typeof body.path === "string" ? body.path.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!parentPath) {
      return Response.json({ error: "Parent path is required" }, { status: 400 });
    }
    if (!name) {
      return Response.json({ error: "Directory name is required" }, { status: 400 });
    }

    if (!isWorkerWorkspacePath(normalizeDirectory(parentPath))) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    const createdPath = await createDirectory(parentPath, name);
    return Response.json({ success: true, path: createdPath });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (code === "EEXIST") {
      return Response.json({ error: "A file or directory with this name already exists" }, { status: 409 });
    }
    if (code === "ENOENT") {
      return Response.json({ error: "Parent directory does not exist" }, { status: 404 });
    }
    if (code === "EACCES" || code === "EPERM") {
      return Response.json({ error: "Permission denied" }, { status: 403 });
    }
    if (code === "EINVAL" || code === "ENAMETOOLONG") {
      return Response.json({ error: "Directory name is invalid" }, { status: 400 });
    }
    if (error instanceof Error && (
      error.message === "Directory name must be a single folder name"
      || error.message === "Parent path is not a directory"
    )) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
