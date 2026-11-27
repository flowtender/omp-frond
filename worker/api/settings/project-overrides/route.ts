import { getPathsForTab, isSetInProjectLayer, isSettingTab } from "@/lib/omp-settings";
import { getSettingsForCwd } from "@/lib/omp-runtime";
import { requireAllowedCwd } from "@/lib/file-access";
import type { ProjectOverridesResponse } from "@/lib/settings-api";


/**
 * GET ?tab=<tab>&project=<root>&project=<root>…: for each project, the
 * settings on the tab its own config sets. A project outside the allowed
 * roots, or one whose settings cannot be read, is left out.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const tab = params.get("tab");
  if (!isSettingTab(tab)) {
    return Response.json({ error: "Unknown settings tab" }, { status: 400 });
  }
  const paths = getPathsForTab(tab);
  const projects = [...new Set(params.getAll("project"))];
  const entries = await Promise.all(projects.map(async (project): Promise<[string, string[]] | null> => {
    try {
      const settings = await getSettingsForCwd(await requireAllowedCwd(project));
      const projectLayer = settings.getProjectSettings();
      return [project, paths.filter((path) => isSetInProjectLayer(projectLayer, path))];
    } catch {
      return null;
    }
  }));
  const response: ProjectOverridesResponse = {
    projects: Object.fromEntries(entries.filter((entry) => entry !== null)),
  };
  return Response.json(response);
}
