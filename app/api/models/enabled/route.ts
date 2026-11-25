import { stat } from "fs/promises";
import { resolve } from "path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import {
  clearEnabledModels,
  constrainProviderEntries,
  pruneStaleEnabledModels,
  renameModelPatterns,
  renameProviderPatterns,
  setModelsEnabled,
  type EnabledModelsEdit,
  type EnabledModelsInput,
  type ProviderRename,
} from "@/lib/enabled-models";
import {
  buildEnabledModelsInput,
  buildEnabledModelsView,
  modelRef,
  readEnabledModelsSettings,
  writeEnabledModels,
  type EnabledModelsView,
} from "@/lib/enabled-models-runtime";
import { groupEnabledModelRows } from "@/lib/enabled-models-presentation";
import { getOmpRuntime, getSettingsForCwd } from "@/lib/omp-runtime";
import { oauthProvidersByCatalogId } from "@/lib/provider-listing-runtime";
import { markModelsSeen, reconcileSeenModels } from "@/lib/seen-models";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateModelsCache } from "@/lib/models-cache";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

interface RequestContext {
  cwd: string;
  agentDir: string;
  models: readonly Model<Api>[];
  /** The process-wide instance; global writes go through it. */
  rootSettings: Settings;
  modelError?: string;
}

async function loadContext(cwd: string): Promise<RequestContext> {
  const { agentDir, settings, modelRegistry } = await getOmpRuntime();
  const modelError = modelRegistry.getError()?.message;
  return {
    cwd,
    agentDir,
    models: modelRegistry.getAvailable(),
    rootSettings: settings,
    ...(modelError ? { modelError } : {}),
  };
}

async function buildView(context: RequestContext): Promise<EnabledModelsView> {
  // Re-scoped per call: a write lands on the root instance, and a cwd clone
  // taken before it would still describe the old value.
  const settings = await getSettingsForCwd(context.cwd);
  const { patterns, path, readOnlyReason } = readEnabledModelsSettings(settings);
  const input = await buildEnabledModelsInput(patterns, context.models, { settings });
  const providerNames = new Map(
    [...oauthProvidersByCatalogId()].map(([providerId, login]) => [providerId, login.name]),
  );
  const view = buildEnabledModelsView({
    input,
    models: context.models,
    providerNames,
    newRefs: reconcileSeenModels(context.agentDir, input.availableRefs),
    settingsPath: path,
    ...(readOnlyReason ? { readOnlyReason } : {}),
    ...(context.modelError ? { modelError: context.modelError } : {}),
  });
  const { modelRegistry } = await getOmpRuntime();
  groupEnabledModelRows(view, settings, modelRegistry, context.models);
  return view;
}

/**
 * Resolve the cwd whose project settings decide whether the global value is
 * shadowed. It is only read, never written, but it still points at a settings
 * file, so it goes through the same allow-list as `/api/files`.
 */
async function resolveCwd(raw: string | null): Promise<{ cwd: string } | { error: Response }> {
  if (!raw) return { cwd: process.cwd() };
  const cwd = resolve(raw);
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return { error: Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 }) };
  }
  if (!cwdStat.isDirectory()) {
    return { error: Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 }) };
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { error: Response.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

export async function GET(req: Request) {
  const resolved = await resolveCwd(new URL(req.url).searchParams.get("cwd"));
  if ("error" in resolved) return resolved.error;

  try {
    return Response.json(await buildView(await loadContext(resolved.cwd)));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

interface EnabledModelsRequest {
  cwd?: unknown;
  op?: unknown;
  provider?: unknown;
  refs?: unknown;
  renames?: unknown;
  modelRenames?: unknown;
  fullyEnabled?: unknown;
  enabled?: unknown;
}

function renamePairs(value: unknown): ProviderRename[] | null {
  if (!Array.isArray(value)) return null;
  const renames: ProviderRename[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { from, to } = entry as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string" || !from || !to) return null;
    renames.push({ from, to });
  }
  return renames;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

/**
 * Repair the stored patterns after models.yml changed under the panel.
 *
 * A pattern's meaning depends on the catalog, and the catalog just moved: a
 * provider rename can make its glob reach into another provider (omp matches
 * patterns against the bare model id too, so `stepfun/*` also matches
 * `commandcode`'s `stepfun/Step-5-Preview`), and renaming a model to an id with
 * a slash drops it out of `provider/*` entirely. So re-resolve, cut entries
 * back to the provider their prefix names, and restore the providers that were
 * fully enabled before the save.
 */
async function resyncAfterModelsConfigSave(
  context: RequestContext,
  settings: Settings,
  input: EnabledModelsInput,
  options: {
    renames: readonly ProviderRename[];
    modelRenames: readonly ProviderRename[];
    fullyEnabled: readonly string[];
  },
): Promise<EnabledModelsEdit> {
  const { renames, modelRenames, fullyEnabled } = options;
  const original = input.patterns;
  const reresolve = (patterns: string[] | undefined) =>
    buildEnabledModelsInput(patterns, context.models, { settings, withProviderGlobs: true });
  // Model references first: they still carry the old provider id, which the
  // provider rewrite below would otherwise have replaced already.
  const renamed = renameProviderPatterns(renameModelPatterns(original, modelRenames), renames);
  let current = renamed === original ? input : await reresolve(renamed);

  const constrained = constrainProviderEntries(current);
  if (constrained.ok && constrained.changed) current = await reresolve(constrained.patterns);

  // A provider that was fully enabled before the save stays fully enabled, even
  // when a model of it was renamed out of the glob that used to cover it.
  const refs = fullyEnabled
    .map((id) => renames.find((rename) => rename.from === id)?.to ?? id)
    .flatMap((id) => context.models.filter((model) => model.provider === id).map(modelRef));
  const edit = setModelsEnabled(current, refs, true);
  if (!edit.ok) return edit;
  return { ok: true, patterns: edit.patterns, changed: !samePatternList(edit.patterns, original) };
}

function samePatternList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((pattern, index) => pattern === b[index]);
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: EnabledModelsRequest;
  try {
    body = await req.json() as EnabledModelsRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const op = body.op;
  if (op !== "models" && op !== "provider" && op !== "clear" && op !== "prune" && op !== "resync") {
    return Response.json({ error: "Invalid op" }, { status: 400 });
  }
  if ((op === "models" || op === "provider") && typeof body.enabled !== "boolean") {
    return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  if (body.cwd !== undefined && typeof body.cwd !== "string") {
    return Response.json({ error: "Invalid cwd" }, { status: 400 });
  }

  const resolved = await resolveCwd(typeof body.cwd === "string" ? body.cwd : null);
  if ("error" in resolved) return resolved.error;

  try {
    const context = await loadContext(resolved.cwd);
    const settings = await getSettingsForCwd(resolved.cwd);
    const { patterns, readOnlyReason } = readEnabledModelsSettings(settings);
    if (readOnlyReason) {
      return Response.json(
        { error: "enabledModels cannot be edited here", reason: readOnlyReason },
        { status: 409 },
      );
    }

    const input = await buildEnabledModelsInput(patterns, context.models, { settings, withProviderGlobs: true });
    let edit: EnabledModelsEdit;
    // Models the user switched: they have been looked at, so they stop being new.
    let switchedRefs: string[] = [];
    if (op === "clear") {
      edit = clearEnabledModels(input);
    } else if (op === "prune") {
      edit = pruneStaleEnabledModels(input);
    } else if (op === "resync") {
      const renames = renamePairs(body.renames);
      const modelRenames = renamePairs(body.modelRenames ?? []);
      const fullyEnabled = stringArray(body.fullyEnabled ?? []);
      if (!renames || !modelRenames || !fullyEnabled) {
        return Response.json({ error: "Invalid resync payload" }, { status: 400 });
      }
      edit = await resyncAfterModelsConfigSave(context, settings, input, { renames, modelRenames, fullyEnabled });
    } else {
      if (op === "provider") {
        if (typeof body.provider !== "string" || !body.provider) {
          return Response.json({ error: "provider is required" }, { status: 400 });
        }
        // Resolved server-side so a provider switched on stays on for models
        // the browser has not seen yet.
        switchedRefs = context.models
          .filter((model) => model.provider === body.provider)
          .map(modelRef);
      } else {
        const requested = stringArray(body.refs);
        if (!requested) return Response.json({ error: "refs must be an array of strings" }, { status: 400 });
        switchedRefs = requested;
      }
      edit = setModelsEnabled(input, switchedRefs, body.enabled === true);
    }

    if (!edit.ok) {
      return Response.json(
        { error: "At least one model must stay enabled", reason: edit.reason },
        { status: 409 },
      );
    }
    if (edit.changed) {
      await writeEnabledModels(context.rootSettings, edit.patterns);
      invalidateModelsCache();
    }
    markModelsSeen(context.agentDir, switchedRefs.filter((ref) => input.availableRefs.includes(ref)));

    return Response.json(await buildView(context));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
