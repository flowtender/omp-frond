import type { ModelPresetActivateResponse, ModelRoleScope } from "@/lib/api-types";
import { invalidateModelsCache } from "@/lib/models-cache";
import {
  modelPresetErrorResponse,
  readPresetsResponse,
  rejectUntrustedJsonWrite,
  requirePresetCwd,
  requirePresetName,
} from "@/lib/model-preset-http";
import { activateModelPreset, defaultRoleThinkingLevel, findPresetShadows, readActivatablePreset } from "@/lib/model-presets";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { listModelRoles, listRoleModelPool } from "@/lib/model-roles";
import { getOmpRuntime, getSettingsForCwd, reloadProjectSettings } from "@/lib/omp-runtime";
import { assertRpcSessionProjectPolicy, getRpcSession } from "@/lib/rpc-manager";
import { RpcProjectTrustError } from "@/lib/project-trust";


/**
 * POST /api/model-presets/activate  body: { cwd?, name, scope, session?, liveSwitch? }
 *
 * Writes the preset's roles and default thinking level into `scope`, then
 * switches `session` (a session or runtime id) to the new default role, as
 * omp's `/modelpreset switch` does for its own session. A session that is not
 * running is left alone: it reads the roles when it starts.
 *
 * `liveSwitch`: `ask` (the default) answers 409 `PROMPT_CACHE_WARM_CODE`,
 * writing nothing, when the switch would discard the session's warm prompt
 * cache; `switch` switches regardless; `skip` writes the roles and leaves the
 * session on its model.
 */
export async function POST(req: Request) {
  const rejected = rejectUntrustedJsonWrite(req);
  if (rejected) return rejected;
  let releasePolicyLease: (() => void) | undefined;
  try {
    const body = await req.json() as { cwd?: unknown; name?: unknown; scope?: unknown; session?: unknown; liveSwitch?: unknown };
    const cwd = await requirePresetCwd(body.cwd);
    const name = requirePresetName(body.name);
    const scope: ModelRoleScope = body.scope === "project" ? "project" : "global";
    const liveSwitch = body.liveSwitch === "switch" || body.liveSwitch === "skip" ? body.liveSwitch : "ask";

    const runtime = await getOmpRuntime();
    const scoped = await getSettingsForCwd(cwd);
    const preset = readActivatablePreset(scoped, name);
    const candidates = await listRoleModelPool(runtime.modelRegistry, scoped);
    const sessionLookup = typeof body.session === "string" ? getRpcSession(body.session) : undefined;
    const live = liveSwitch !== "skip" && sessionLookup?.isAlive() ? sessionLookup : undefined;
    if (live) {
      releasePolicyLease = live.acquireProjectPolicyLease();
      await assertRpcSessionProjectPolicy(live, req.headers.get("X-OMP-Project-Opening") ?? undefined);
    }

    if (live && liveSwitch === "ask") {
      // The default role the switch would land on, before anything is written.
      const target = resolveModelRoleValue(preset.modelRoles.default ?? scoped.getModelRole("default"), candidates, { settings: scoped });
      if (target.model) {
        const thinkingLevel = defaultRoleThinkingLevel(target, preset.defaultThinkingLevel, cfgDefaultThinkingLevel.get(scoped));
        live.confirmPromptCacheLoss(live.promptCacheChangeFor({ model: target.model, thinkingLevel }), false);
      }
    }

    await activateModelPreset({ scoped, global: runtime.settings, cwd, preset, scope, candidates });
    if (scope === "project" && cwd) await reloadProjectSettings(cwd);
    invalidateModelsCache();

    const settings = await getSettingsForCwd(cwd);
    const response: ModelPresetActivateResponse = {
      roles: listModelRoles(settings, runtime.modelRegistry.getAvailable("all")),
      presets: (await readPresetsResponse(cwd)).presets,
      ...findPresetShadows(settings, preset),
    };
    if (live) {
      try {
        response.live = await live.send({ type: "apply_model_roles", thinkingLevel: preset.defaultThinkingLevel }) as {
          provider: string;
          modelId: string;
        };
      } catch (error) {
        response.liveError = error instanceof Error ? error.message : String(error);
      }
    }
    return Response.json(response);
  } catch (error) {
    if (error instanceof RpcProjectTrustError) return Response.json({ error: error.message }, { status: error.status });
    return modelPresetErrorResponse(error);
  } finally {
    releasePolicyLease?.();
  }
}
