import { homedir } from "os";
import { workerWorkspaceRoot } from "@/lib/worker-workspace";

export async function GET() {
  return Response.json({ home: workerWorkspaceRoot ?? homedir() });
}
