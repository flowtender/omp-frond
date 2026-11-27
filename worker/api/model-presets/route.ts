import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { invalidateModelsCache } from "@/lib/models-cache";
import {
  modelPresetErrorResponse,
  readPresetsResponse,
  rejectUntrustedJsonWrite,
  requirePresetCwd,
  requirePresetName,
} from "@/lib/model-preset-http";
import { createModelPreset, parseModelPresetInput, removeModelPreset, updateModelPreset } from "@/lib/model-presets";
import { getOmpRuntime, getSettingsForCwd } from "@/lib/omp-runtime";
import { isApiRequestAllowed } from "@/lib/request-security";


/** Presets are saved to the global config, through the process-wide Settings as every global edit is. */
async function writeGlobalPreset(cwd: string | undefined, write: (scoped: Settings, global: Settings) => void): Promise<void> {
  const { settings: global } = await getOmpRuntime();
  write(await getSettingsForCwd(cwd), global);
  await global.flush();
  invalidateModelsCache();
}

// GET /api/model-presets[?cwd=<path>] — omp's saved model presets.
export async function GET(req: Request) {
  try {
    const cwd = await requirePresetCwd(new URL(req.url).searchParams.get("cwd"));
    return Response.json(await readPresetsResponse(cwd));
  } catch (error) {
    return modelPresetErrorResponse(error);
  }
}

// POST /api/model-presets  body: { cwd, name } — save the current roles as a new preset.
export async function POST(req: Request) {
  const rejected = rejectUntrustedJsonWrite(req);
  if (rejected) return rejected;
  try {
    const body = await req.json() as { cwd?: unknown; name?: unknown };
    const cwd = await requirePresetCwd(body.cwd);
    const name = requirePresetName(body.name);
    await writeGlobalPreset(cwd, (scoped, global) => createModelPreset(scoped, global, name));
    return Response.json(await readPresetsResponse(cwd));
  } catch (error) {
    return modelPresetErrorResponse(error);
  }
}

// PUT /api/model-presets  body: { cwd, name, modelRoles, defaultThinkingLevel? } — replace a global preset.
export async function PUT(req: Request) {
  const rejected = rejectUntrustedJsonWrite(req);
  if (rejected) return rejected;
  try {
    const body = await req.json() as { cwd?: unknown; name?: unknown; modelRoles?: unknown; defaultThinkingLevel?: unknown };
    const cwd = await requirePresetCwd(body.cwd);
    const name = requirePresetName(body.name);
    const preset = parseModelPresetInput(body.modelRoles, body.defaultThinkingLevel);
    await writeGlobalPreset(cwd, (scoped, global) => updateModelPreset(scoped, global, name, preset));
    return Response.json(await readPresetsResponse(cwd));
  } catch (error) {
    return modelPresetErrorResponse(error);
  }
}

// DELETE /api/model-presets?cwd=<path>&name=<preset> — remove a global preset.
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const params = new URL(req.url).searchParams;
    const cwd = await requirePresetCwd(params.get("cwd"));
    const name = requirePresetName(params.get("name"));
    await writeGlobalPreset(cwd, (scoped, global) => removeModelPreset(scoped, global, name));
    return Response.json(await readPresetsResponse(cwd));
  } catch (error) {
    return modelPresetErrorResponse(error);
  }
}
