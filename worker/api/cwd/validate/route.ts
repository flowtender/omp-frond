import { realpathSync, statSync } from "fs";
import { allowFileRoot } from "@/lib/file-access";
import { normalizeDirectory } from "@/lib/directory-browser";
import { projectIdentityKey } from "@/lib/project-identity";
import { resolveProject } from "@/lib/worktree";
import { isWorkerWorkspacePath } from "@/lib/worker-workspace";


// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return Response.json({ error: "Path is required" }, { status: 400 });
    }

    const normalizedCwd = normalizeDirectory(cwd);
    let canonicalCwd: string;
    try {
      const stat = statSync(normalizedCwd);
      if (!stat.isDirectory()) {
        return Response.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
      }
      canonicalCwd = realpathSync(normalizedCwd);
    } catch {
      return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    if (!isWorkerWorkspacePath(canonicalCwd)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    allowFileRoot(canonicalCwd);
    // The UI keys worktree grouping and authorization scope on the server's
    // own project identity, not on the path it happened to send.
    const project = await resolveProject(canonicalCwd);
    if (!isWorkerWorkspacePath(project.projectRoot)) {
      return Response.json({ error: "Project root is outside this worker's workspace" }, { status: 403 });
    }
    return Response.json({
      success: true,
      cwd: canonicalCwd,
      projectRoot: project.projectRoot,
      projectKey: projectIdentityKey(project.projectRoot),
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
