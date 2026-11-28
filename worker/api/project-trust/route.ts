import { stat } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { resolveAgentDir } from "@/bin/web-auth-store";
import type { ProjectTrustChoice, ProjectTrustResponse } from "@/lib/api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateModelsCache } from "@/lib/models-cache";
import { readProjectMcpListing } from "@/lib/project-mcp-listing";
import { getProjectTrustStatus, isProjectOpeningId, setProjectTrustDecision } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";


async function validateCwd(value: unknown): Promise<
  { cwd: string; allowedRoots: Set<string> } | { response: Response }
> {
  if (typeof value !== "string" || !isAbsolute(value)) {
    return { response: Response.json({ error: "An absolute cwd is required", reason: "cwd-invalid" }, { status: 400 }) };
  }

  const cwd = resolve(value);
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return { response: Response.json({ error: "cwd must be a directory", reason: "cwd-not-directory" }, { status: 400 }) };
    }
  } catch {
    return { response: Response.json({ error: "Directory does not exist", reason: "cwd-denied" }, { status: 400 }) };
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { response: Response.json({ error: "Access denied", reason: "cwd-denied" }, { status: 403 }) };
  }
  return { cwd, allowedRoots };
}

export async function GET(req: Request) {
  const result = await validateCwd(new URL(req.url).searchParams.get("cwd"));
  if ("response" in result) return result.response;
  const agentDir = resolveAgentDir();
  const { checkoutRoot, folder, ...assessment } = await getProjectTrustStatus(result.cwd, agentDir);
  const status: ProjectTrustResponse = {
    ...assessment,
    ...readProjectMcpListing(folder, checkoutRoot, assessment.resources, result.allowedRoots, agentDir),
  };
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}

const TRUST_CHOICES: readonly ProjectTrustChoice[] = ["trust-chat", "distrust-chat", "always-trust", "always-distrust"];

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted request", reason: "request-denied" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Expected JSON", reason: "content-type" }, { status: 415 });
  const body = await req.json().catch(() => null) as {
    cwd?: unknown; openingId?: unknown; choice?: ProjectTrustChoice; projectRoot?: unknown; sessionId?: unknown;
  } | null;
  if (!body?.choice || !TRUST_CHOICES.includes(body.choice) || !isProjectOpeningId(body.openingId) ||
    typeof body.projectRoot !== "string" || (body.sessionId !== undefined &&
      (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.startsWith("runtime:")))) {
    return Response.json({ error: "Invalid project trust choice", reason: "invalid-request" }, { status: 400 });
  }
  try {
    const result = await validateCwd(body.cwd);
    if ("response" in result) return result.response;
    const agentDir = resolveAgentDir();
    const status = await setProjectTrustDecision(
      result.cwd, agentDir, body.projectRoot, body.choice, body.openingId, body.sessionId,
    );
    if (!status) return Response.json({ error: "The project or chat opening changed. Reopen the trust dialog." }, { status: 409 });
    invalidateModelsCache();
    const { checkoutRoot, folder, ...assessment } = status;
    const response: ProjectTrustResponse = {
      ...assessment,
      ...readProjectMcpListing(folder, checkoutRoot, assessment.resources, result.allowedRoots, agentDir),
    };
    return Response.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not save omp-frond's project decision", reason: "internal" }, { status: 500 });
  }
}
