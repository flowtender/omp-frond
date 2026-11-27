import os from "os";
import { requireAllowedCwd } from "@/lib/file-access";
import { formatPythonSource, installedPythonFormatters } from "@/lib/python-formatter";
import type { PythonFormatterChoice } from "@/lib/python-format-shared";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";


// GET  /api/format/python  -> { installed: { ruff, black } }
// POST /api/format/python  body: { source, cwd?, formatter? } -> { formatted: string | null }
// Display-only formatting of Python eval cells with the formatter the machine already has.
// `formatted` is null when none applies or the source is not valid Python.

async function formatterCwd(cwd: unknown): Promise<string> {
  // Without a project the formatter still reads the user's own config, never a project's.
  return typeof cwd === "string" && cwd ? requireAllowedCwd(cwd) : os.tmpdir();
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return Response.json({ installed: await installedPythonFormatters(os.tmpdir()) });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: { source?: unknown; cwd?: unknown; formatter?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || typeof body.source !== "string") {
    return Response.json({ error: "source must be a string" }, { status: 400 });
  }
  const formatter: PythonFormatterChoice = body.formatter === "ruff" || body.formatter === "black" ? body.formatter : "auto";
  let cwd: string;
  try {
    cwd = await formatterCwd(body.cwd);
  } catch {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }
  return Response.json({ formatted: await formatPythonSource(body.source, cwd, formatter) });
}
