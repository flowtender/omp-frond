import { resolveAgentDir } from "@/bin/web-auth-store";
import { runNpx, getSafeNpxEnv, redactNpxOutput } from "@/lib/npx";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";


const ANSI_RE = /\x1B\[[0-9;]*m/g;
const SKILL_PACKAGE_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+@[A-Za-z0-9_.-]+$/;
const MAX_SKILL_PACKAGE_LENGTH = 256;

// POST /api/skills/install  body: { package: string; scope: "global" | "project"; cwd?: string }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { package?: unknown; scope?: unknown; cwd?: unknown };
    const pkg = typeof body.package === "string" ? body.package.trim() : "";
    const scope = body.scope;
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!pkg) return Response.json({ error: "package required" }, { status: 400 });
    if (pkg.length > MAX_SKILL_PACKAGE_LENGTH || !SKILL_PACKAGE_RE.test(pkg)) {
      return Response.json({ error: "package must be a GitHub skill reference" }, { status: 400 });
    }
    if (scope !== "global" && scope !== "project") {
      return Response.json({ error: "scope must be global or project" }, { status: 400 });
    }

    const isGlobal = scope === "global";
    if (!isGlobal) {
      if (!cwd) return Response.json({ error: "cwd required for project install" }, { status: 400 });
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return Response.json({ error: "Access denied" }, { status: 403 });
      }
      if (!(await getProjectTrustStatus(cwd, resolveAgentDir())).trusted) {
        return Response.json(
          { error: "Project resources must be trusted before installing project skills" },
          { status: 403 },
        );
      }
    }
    const args = ["skills", "add", pkg, "-y", "--agent", "claude-code"];
    if (isGlobal) args.push("-g");

    console.log(`[skills/install] running: npx ${args.join(" ")}`);
    const { stdout, stderr } = await runNpx(args, {
      timeout: 60000,
      cwd: !isGlobal ? cwd : undefined,
      env: getSafeNpxEnv({ FORCE_COLOR: "0" }),
    });

    const output = redactNpxOutput(stdout + stderr).replace(ANSI_RE, "").slice(-4000);
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) {
      return Response.json({ error: output || "Install failed" }, { status: 500 });
    }
    return Response.json({ success: true, output });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = redactNpxOutput((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, "").slice(-4000);
    return Response.json({ error: output || "Install failed" }, { status: 500 });
  }
}
