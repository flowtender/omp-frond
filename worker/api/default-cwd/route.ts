import { mkdirSync } from "fs";
import { defaultCwdPath } from "@/lib/default-cwd";
import { workerWorkspaceRoot } from "@/lib/worker-workspace";

// POST /api/default-cwd
// Creates ~/omp-cwd-<YYYYMMDD> (local date) if it doesn't exist and returns the path.
// The client then selects it through /api/cwd/validate like any other directory.
export async function POST() {
  try {
    const dir = defaultCwdPath(new Date(), workerWorkspaceRoot);
    mkdirSync(dir, { recursive: true });
    return Response.json({ cwd: dir });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
