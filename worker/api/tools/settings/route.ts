import type { ToolSettingsResponse } from "@/lib/api-types";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  readPowerShellToolEnabled,
  writePowerShellToolEnabled,
} from "@/lib/powershell-settings";


// The only writer of the global `defaultTools` key's shell entry: the
// PowerShell switch in Settings swaps `bash` for `powershell` (Windows only)
// through the locked global-settings file. omp has no codemode, so the
// upstream route's codemode branches have no fork counterpart.

function errorResponse(error: unknown) {
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

async function readToolSettings(): Promise<ToolSettingsResponse> {
  const powerShellEnabled = await readPowerShellToolEnabled();
  return { isWindows: process.platform === "win32", powerShellEnabled };
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return Response.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const changes = body as { enabled?: unknown };
  if (typeof changes.enabled !== "boolean") {
    return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  try {
    await writePowerShellToolEnabled(changes.enabled);
    return Response.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}
