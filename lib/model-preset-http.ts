import { NextResponse } from "next/server";
import { resolve } from "path";
import type { ModelPresetsResponse } from "./api-types";
import { requireAllowedCwd } from "./file-access";
import { listModelPresets, ModelPresetError } from "./model-presets";
import { getOmpRuntime, getSettingsForCwd } from "./omp-runtime";
import { PromptCacheLossError, promptCacheLossBody } from "./prompt-cache";
import { hasJsonContentType, isApiRequestAllowed } from "./request-security";

/** Request plumbing shared by `/api/model-presets` and its `activate` route. */

export function modelPresetErrorResponse(error: unknown): NextResponse {
  if (error instanceof PromptCacheLossError) return NextResponse.json(promptCacheLossBody(error), { status: 409 });
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ModelPresetError ? error.status : message === "Access denied" ? 403 : 500;
  return NextResponse.json({ error: message }, { status });
}

export function rejectUntrustedJsonWrite(req: Request): NextResponse | undefined {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return undefined;
}

/** An absent cwd means no project: the global presets and roles only. */
export async function requirePresetCwd(raw: unknown): Promise<string | undefined> {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new ModelPresetError("cwd must be a path", 400);
  return requireAllowedCwd(resolve(raw));
}

export function requirePresetName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ModelPresetError("name required", 400);
  return raw.trim();
}

/** The presets as the project at `cwd` (or none) sees them, re-read after a write. */
export async function readPresetsResponse(cwd: string | undefined): Promise<ModelPresetsResponse> {
  const { modelRegistry } = await getOmpRuntime();
  return { presets: listModelPresets(await getSettingsForCwd(cwd), modelRegistry.getAvailable("all")) };
}
