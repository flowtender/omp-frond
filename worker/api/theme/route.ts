import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getSettingsForCwd } from "@/lib/omp-runtime";
import { getWebThemeConfig } from "@/lib/omp-theme";
import { isApiRequestAllowed } from "@/lib/request-security";


export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
    if (cwd) {
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return Response.json({ error: "Access denied" }, { status: 403 });
      }
    }
    return Response.json(await getWebThemeConfig(await getSettingsForCwd(cwd)));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
