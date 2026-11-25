import { NextResponse } from "next/server";
import {
  getDefault,
  getEnumValues,
  getPathsForTab,
  getSegments,
  getType,
  getUi,
  hasUi,
  isCredential,
  isSetInProjectLayer,
  isSettingTab,
  SETTING_TABS,
  TAB_GROUPS,
  SETTINGS_PAGES,
  findSetting,
  getSetting,
  isSettingConfigured,
  setSetting,
  type SettingPath,
} from "@/lib/omp-settings";
import { getOmpRuntime, getSettingsForCwd, reloadProjectSettings } from "@/lib/omp-runtime";
import { requireAllowedCwd } from "@/lib/file-access";
import { getAvailableWebThemes, getWebThemeConfig } from "@/lib/omp-theme";
import { removeProjectSettings, writeProjectSetting } from "@/lib/project-settings-file";
import type {
  SettingsField,
  SettingsFieldType,
  SettingsOption,
  SettingsResponse,
  SettingsValue,
} from "@/lib/settings-api";

export const dynamic = "force-dynamic";

// `?cwd=` reads the settings a session there sees. `?project=` does the same
// for a project root and also marks what the project's own config sets;
// PATCH and DELETE with a project write that project's `.omp/config.yml`.

async function validateCwd(cwd: string | null | undefined): Promise<string | undefined> {
  return cwd ? requireAllowedCwd(cwd) : undefined;
}

function errorResponse(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : status });
}

function optionsFor(path: SettingPath, runtimeThemes: string[]): SettingsOption[] | undefined {
  const ui = getUi(path);
  if (!ui) return undefined;
  if (ui.options === "runtime") {
    return path === "theme.dark" || path === "theme.light"
      ? runtimeThemes.map((value) => ({ value, label: value }))
      : [];
  }
  if (Array.isArray(ui.options)) return ui.options.map((option) => ({ ...option }));
  const values = getEnumValues(path);
  return values?.map((value) => ({ value, label: value }));
}

function fieldTypeFor(path: SettingPath): SettingsFieldType | null {
  const schemaType = getType(path);
  const ui = getUi(path);
  if (!ui) return null;
  if (schemaType === "boolean") return "boolean";
  if (schemaType === "enum") return "select";
  if (schemaType === "string") return isCredential(path) ? "secret" : ui.options ? "select" : "text";
  if (schemaType === "number") return ui.options ? "select" : null;
  if (schemaType === "array") return ui.options ? "multiselect" : null;
  if (schemaType === "record") return path === "providers.maxInFlightRequests" ? "providerLimits" : "text";
  return null;
}

function serializableValue(value: unknown): SettingsValue {
  if (value === undefined) return null;
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
    || typeof value === "number"
    || Array.isArray(value)
  ) return value as SettingsValue;
  return value as Record<string, number>;
}

function validateSettingValue(path: SettingPath, value: unknown): SettingsValue {
  const schemaType = getType(path);
  const ui = getUi(path);
  if (!ui) throw new Error("Setting is not exposed by /settings");

  if (schemaType === "boolean") {
    if (typeof value !== "boolean") throw new Error("Expected a boolean");
    return value;
  }
  if (schemaType === "string") {
    if (typeof value !== "string") throw new Error("Expected text");
    const allowed = optionsFor(path, []);
    if (ui.options !== "runtime" && allowed?.length && !allowed.some((option) => option.value === value)) {
      throw new Error("Invalid option");
    }
    return value;
  }
  if (schemaType === "enum") {
    if (typeof value !== "string" || !getEnumValues(path)?.includes(value)) throw new Error("Invalid option");
    return value;
  }
  if (schemaType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite number");
    const allowed = Array.isArray(ui.options) ? ui.options.map((option) => Number(option.value)) : [];
    if (allowed.length && !allowed.includes(value)) throw new Error("Invalid option");
    return value;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected a string list");
    const allowed = Array.isArray(ui.options) ? new Set(ui.options.map((option) => option.value)) : null;
    if (!allowed || value.some((item) => !allowed.has(item))) throw new Error("Invalid list option");
    return [...new Set(value)] as string[];
  }
  if (schemaType === "record" && path === "providers.maxInFlightRequests") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected provider limits");
    const result: Record<string, number> = {};
    for (const [provider, limit] of Object.entries(value)) {
      if (!provider.trim() || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
        throw new Error("Provider limits must be positive numbers");
      }
      result[provider.trim()] = Math.floor(limit);
    }
    return result;
  }
  throw new Error("Unsupported setting type");
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const project = await validateCwd(params.get("project"));
    const settings = await getSettingsForCwd(project ?? await validateCwd(params.get("cwd")));
    const projectLayer = project ? settings.getProjectSettings() : null;
    const [availableThemes, theme] = await Promise.all([
      getAvailableWebThemes(),
      getWebThemeConfig(settings),
    ]);
    const themeNames = availableThemes.map(({ name }) => name);
    const fields: SettingsField[] = [];

    for (const tab of SETTING_TABS) {
      for (const path of getPathsForTab(tab)) {
        const fieldType = fieldTypeFor(path);
        const ui = getUi(path);
        if (!fieldType || !ui) continue;
        const secret = isCredential(path);
        fields.push({
          path,
          tab,
          group: ui.group,
          label: ui.label,
          description: ui.description,
          type: fieldType,
          value: secret ? null : serializableValue(getSetting(settings, path)),
          defaultValue: secret ? null : serializableValue(getDefault(path)),
          configured: isSettingConfigured(settings, path),
          ...(projectLayer ? { projectOverride: isSetInProjectLayer(projectLayer, path) } : {}),
          options: optionsFor(path, themeNames),
          ordered: ui.ordered === true,
          condition: ui.condition,
        });
      }
    }

    const response: SettingsResponse = {
      tabs: SETTING_TABS.map((id) => ({ id, label: SETTINGS_PAGES[id].label, groups: [...TAB_GROUPS[id]] })),
      fields,
      availableThemes,
      theme,
    };
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { path?: string; value?: unknown; project?: string };
    if (!body.path || !findSetting(body.path) || !hasUi(body.path as SettingPath)) {
      return NextResponse.json({ error: "Unknown setting" }, { status: 400 });
    }
    const path = body.path as SettingPath;
    const value = validateSettingValue(path, body.value);
    if (
      (path === "theme.dark" || path === "theme.light")
      && (typeof value !== "string" || !(await getAvailableWebThemes()).some(({ name }) => name === value))
    ) {
      throw new Error("Unknown omp theme");
    }
    const project = await validateCwd(body.project);
    if (project) {
      // A project's config is a file in the repository: no credential goes there.
      if (isCredential(path)) throw new Error("Credentials can only be saved globally");
      await writeProjectSetting(project, getSegments(path), value);
      await reloadProjectSettings(project);
      return NextResponse.json({ success: true, value: serializableValue(getSetting(await getSettingsForCwd(project), path)) });
    }
    const { settings } = await getOmpRuntime();
    setSetting(settings, path, value);
    await settings.flush();
    return NextResponse.json({ success: true, value: serializableValue(getSetting(settings, path)) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * `?project=<root>&path=<setting>` or `?project=<root>&tab=<tab>`: removes the
 * setting, or every setting on the tab, from the project's own config, so the
 * global value applies there again.
 */
export async function DELETE(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const project = await validateCwd(params.get("project"));
    if (!project) return NextResponse.json({ error: "project is required" }, { status: 400 });
    const path = params.get("path");
    const tab = params.get("tab");
    let paths: SettingPath[];
    if (path) {
      if (!findSetting(path) || !hasUi(path)) return NextResponse.json({ error: "Unknown setting" }, { status: 400 });
      paths = [path];
    } else if (isSettingTab(tab)) {
      paths = getPathsForTab(tab);
    } else {
      return NextResponse.json({ error: "path or tab is required" }, { status: 400 });
    }
    await removeProjectSettings(project, paths.map(getSegments));
    await reloadProjectSettings(project);
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
