import { NextResponse } from "next/server";
import { resolve } from "path";
import { getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelRoleSettingsResponse } from "@/lib/api-types";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getOmpRuntime, getSettingsForCwd } from "@/lib/omp-runtime";
import { listModelRoles, listRoleModelPool, writeModelRole, type ModelRoleScope } from "@/lib/model-roles";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** An absent cwd reads the global roles only, as a settings dialog opened without a project does. */
async function requireAllowedCwd(rawCwd: string | null): Promise<{ cwd: string | undefined } | { error: NextResponse }> {
  if (!rawCwd) return { cwd: undefined };
  const cwd = resolve(rawCwd);
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { error: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

// GET /api/model-roles[?cwd=<path>] — every role omp knows, with its assignment.
// A role's candidates follow the Models tab's enabledModels filters.
export async function GET(req: Request) {
  const result = await requireAllowedCwd(new URL(req.url).searchParams.get("cwd"));
  if ("error" in result) return result.error;

  try {
    const { modelRegistry } = await getOmpRuntime();
    const settings = await getSettingsForCwd(result.cwd);
    const roles = listModelRoles(settings, modelRegistry.getAvailable("all"));
    const pool = (await listRoleModelPool(modelRegistry, settings)).map((model) => ({
      model,
      candidate: {
        selector: `${model.provider}/${model.id}`,
        provider: model.provider,
        name: model.name || model.id,
        thinkingLevels: [...getSupportedEfforts(model)],
      },
    }));
    const candidates = Object.fromEntries(roles.filter((role) => !role.hidden).map(({ role }) => {
      const { accepts } = getRoleInfo(role, settings);
      return [role, pool.filter(({ model }) => accepts(model)).map(({ candidate }) => candidate)];
    }));
    return NextResponse.json({ roles, candidates } satisfies ModelRoleSettingsResponse);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/**
 * PUT /api/model-roles  body: { cwd, role, selector, scope }
 *
 * `selector` is omp's own model-role syntax — `provider/modelId` with an
 * optional `:thinkingLevel` suffix — so a value written here reads back
 * identically in `omp`'s `/model` selector. `selector: null` clears the role at
 * that layer and lets the next layer down take over.
 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      cwd?: string;
      role?: string;
      selector?: string | null;
      scope?: ModelRoleScope;
    };
    const result = await requireAllowedCwd(body.cwd ?? null);
    if ("error" in result) return result.error;

    const role = body.role?.trim();
    if (!role) return NextResponse.json({ error: "role required" }, { status: 400 });
    const scope: ModelRoleScope = body.scope === "project" ? "project" : "global";
    if (scope === "project" && !result.cwd) {
      return NextResponse.json({ error: "cwd required to write a project's roles" }, { status: 400 });
    }
    const selector = typeof body.selector === "string" ? body.selector.trim() : undefined;

    const runtime = await getOmpRuntime();
    const settingsToWrite = scope === "global"
      ? runtime.settings
      : await getSettingsForCwd(result.cwd);
    writeModelRole(settingsToWrite, role, selector || undefined, scope);
    await settingsToWrite.flush();
    invalidateModelsCache();

    // Global roles are written through the canonical process-wide Settings
    // instance; re-scope after the flush so project overrides are reflected in
    // the response and in the next modal load.
    const settings = await getSettingsForCwd(result.cwd);
    return NextResponse.json({ roles: listModelRoles(settings, runtime.modelRegistry.getAvailable("all")) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
