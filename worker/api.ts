import * as agent from "./api/agent/[id]/route";
import * as agentBashOutput from "./api/agent/[id]/bash-output/route";
import * as agentEvents from "./api/agent/[id]/events/route";
import * as agentFormMedia from "./api/agent/[id]/form-media/[token]/[index]/route";
import * as agentLease from "./api/agent/[id]/lease/route";
import * as newAgent from "./api/agent/new/route";
import * as running from "./api/agent/running/route";
import * as allProviders from "./api/auth/all-providers/route";
import * as apiKey from "./api/auth/api-key/[provider]/route";
import * as login from "./api/auth/login/[provider]/route";
import * as logout from "./api/auth/logout/[provider]/route";
import * as providers from "./api/auth/providers/route";
import * as browseCwd from "./api/cwd/browse/route";
import * as validateCwd from "./api/cwd/validate/route";
import * as defaultCwd from "./api/default-cwd/route";
import * as displaySettings from "./api/display-settings/route";
import * as fileIndex from "./api/file-index/route";
import * as files from "./api/files/[...path]/route";
import * as formatPython from "./api/format/python/route";
import * as gitDiff from "./api/git/diff/route";
import * as gitStatus from "./api/git/status/route";
import * as home from "./api/home/route";
import * as mcp from "./api/mcp/route";
import * as modelPresets from "./api/model-presets/route";
import * as activatePreset from "./api/model-presets/activate/route";
import * as modelRoles from "./api/model-roles/route";
import * as modelsConfig from "./api/models-config/route";
import * as modelCatalog from "./api/models-config/catalog/route";
import * as discoverModels from "./api/models-config/discover/route";
import * as testModel from "./api/models-config/test/route";
import * as models from "./api/models/route";
import * as enabledModels from "./api/models/enabled/route";
import * as openExplorer from "./api/open-in-explorer/route";
import * as plugins from "./api/plugins/route";
import * as projectTrust from "./api/project-trust/route";
import * as providerUsage from "./api/provider-usage/route";
import * as pushConfig from "./api/push/config/route";
import * as pushSubscribe from "./api/push/subscribe/route";
import * as sessions from "./api/sessions/route";
import * as session from "./api/sessions/[id]/route";
import * as autoName from "./api/sessions/[id]/auto-name/route";
import * as sessionContext from "./api/sessions/[id]/context/route";
import * as sessionDraft from "./api/sessions/[id]/draft/route";
import * as thinking from "./api/sessions/[id]/entries/[entryId]/thinking/route";
import * as toolResultImage from "./api/sessions/[id]/entries/[entryId]/tool-result-image/route";
import * as exportSession from "./api/sessions/[id]/export/route";
import * as forkSession from "./api/sessions/[id]/fork/route";
import * as sessionState from "./api/sessions/[id]/state/route";
import * as deleteSessions from "./api/sessions/delete/route";
import * as promptCache from "./api/sessions/prompt-cache/route";
import * as searchSessions from "./api/sessions/search/route";
import * as sessionStats from "./api/sessions/stats/route";
import * as sessionUiState from "./api/sessions/ui-state/route";
import * as settings from "./api/settings/route";
import * as projectOverrides from "./api/settings/project-overrides/route";
import * as skills from "./api/skills/route";
import * as checkSkills from "./api/skills/check/route";
import * as skillContent from "./api/skills/content/route";
import * as installSkill from "./api/skills/install/route";
import * as searchSkills from "./api/skills/search/route";
import * as updateSkills from "./api/skills/update/route";
import * as terminal from "./api/terminal/route";
import * as terminalSession from "./api/terminal/[id]/route";
import * as terminalEvents from "./api/terminal/[id]/events/route";
import * as theme from "./api/theme/route";
import * as toolSettings from "./api/tools/settings/route";
import * as worktrees from "./api/worktrees/route";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
type Method = (typeof METHODS)[number];
type SegmentParams<S extends string> = S extends `[...${infer Key}]` ? Record<Key, string[]>
  : S extends `[${infer Key}]` ? Record<Key, string> : object;
type Params<Path extends string> = Path extends `${infer First}/${infer Rest}`
  ? SegmentParams<First> & Params<Rest> : SegmentParams<Path>;
type Handlers<Path extends string> = Partial<Record<Method, (
  req: Request, context: { params: Promise<Params<Path>> },
) => Response | Promise<Response>>>;

const staticRoutes = new Map<string, (req: Request) => Promise<Response>>();
const dynamicRoutes: { pattern: RegExp; handle: (req: Request, match: RegExpExecArray) => Promise<Response> }[] = [];

function route<Path extends `/api/${string}`>(path: Path, handlers: Handlers<NoInfer<Path>>) {
  const allowed = METHODS.filter((method) => handlers[method] || method === "OPTIONS" || (method === "HEAD" && handlers.GET));
  const allow = allowed.join(", ");
  const handle = async (req: Request, params: Params<Path>): Promise<Response> => {
    const method = req.method as Method;
    const handler = Object.hasOwn(handlers, method)
      ? handlers[method] : method === "HEAD" ? handlers.GET : undefined;
    if (!handler) {
      return new Response(null, { status: method === "OPTIONS" ? 204 : 405, headers: { Allow: allow } });
    }
    const response = await handler(req, { params: Promise.resolve(params) });
    if (method !== "HEAD") return response;
    await response.body?.cancel();
    return new Response(null, { status: response.status, headers: response.headers });
  };
  const keys: { name: string; many: boolean }[] = [];
  const pattern = path.replace(/\[(\.\.\.)?(\w+)\]/g, (_segment, spread: string | undefined, name: string) => {
    keys.push({ name, many: Boolean(spread) });
    return spread ? "(.+)" : "([^/]+)";
  });
  if (keys.length === 0) {
    staticRoutes.set(path, (req) => handle(req, {} as Params<Path>));
    return;
  }
  dynamicRoutes.push({
    pattern: new RegExp(`^${pattern}$`),
    handle(req, match) {
      let params: Params<Path>;
      try {
        params = Object.fromEntries(keys.map(({ name, many }, index) => {
          const value = match[index + 1];
          return [name, many ? value.split("/").map(decodeURIComponent) : decodeURIComponent(value)];
        })) as Params<Path>;
      } catch {
        return Promise.resolve(Response.json({ error: "Invalid path encoding" }, { status: 400 }));
      }
      return handle(req, params);
    },
  });
}

route("/api/agent/[id]", agent);
route("/api/agent/[id]/bash-output", agentBashOutput);
route("/api/agent/[id]/events", agentEvents);
route("/api/agent/[id]/form-media/[token]/[index]", agentFormMedia);
route("/api/agent/[id]/lease", agentLease);
route("/api/agent/new", newAgent);
route("/api/agent/running", running);
route("/api/auth/all-providers", allProviders);
route("/api/auth/api-key/[provider]", apiKey);
route("/api/auth/login/[provider]", login);
route("/api/auth/logout/[provider]", logout);
route("/api/auth/providers", providers);
route("/api/cwd/browse", browseCwd);
route("/api/cwd/validate", validateCwd);
route("/api/default-cwd", defaultCwd);
route("/api/display-settings", displaySettings);
route("/api/file-index", fileIndex);
route("/api/files/[...path]", files);
route("/api/format/python", formatPython);
route("/api/git/diff", gitDiff);
route("/api/git/status", gitStatus);
route("/api/home", home);
route("/api/mcp", mcp);
route("/api/model-presets", modelPresets);
route("/api/model-presets/activate", activatePreset);
route("/api/model-roles", modelRoles);
route("/api/models-config", modelsConfig);
route("/api/models-config/catalog", modelCatalog);
route("/api/models-config/discover", discoverModels);
route("/api/models-config/test", testModel);
route("/api/models", models);
route("/api/models/enabled", enabledModels);
route("/api/open-in-explorer", openExplorer);
route("/api/plugins", plugins);
route("/api/project-trust", projectTrust);
route("/api/provider-usage", providerUsage);
route("/api/push/config", pushConfig);
route("/api/push/subscribe", pushSubscribe);
route("/api/sessions", sessions);
route("/api/sessions/[id]", session);
route("/api/sessions/[id]/auto-name", autoName);
route("/api/sessions/[id]/context", sessionContext);
route("/api/sessions/[id]/draft", sessionDraft);
route("/api/sessions/[id]/entries/[entryId]/thinking", thinking);
route("/api/sessions/[id]/entries/[entryId]/tool-result-image", toolResultImage);
route("/api/sessions/[id]/export", exportSession);
route("/api/sessions/[id]/fork", forkSession);
route("/api/sessions/[id]/state", sessionState);
route("/api/sessions/delete", deleteSessions);
route("/api/sessions/prompt-cache", promptCache);
route("/api/sessions/search", searchSessions);
route("/api/sessions/stats", sessionStats);
route("/api/sessions/ui-state", sessionUiState);
route("/api/settings", settings);
route("/api/settings/project-overrides", projectOverrides);
route("/api/skills", skills);
route("/api/skills/check", checkSkills);
route("/api/skills/content", skillContent);
route("/api/skills/install", installSkill);
route("/api/skills/search", searchSkills);
route("/api/skills/update", updateSkills);
route("/api/terminal", terminal);
route("/api/terminal/[id]", terminalSession);
route("/api/terminal/[id]/events", terminalEvents);
route("/api/theme", theme);
route("/api/tools/settings", toolSettings);
route("/api/worktrees", worktrees);

export function handleWorkerApi(req: Request): Response | Promise<Response> {
  const { pathname } = new URL(req.url);
  const exact = staticRoutes.get(pathname);
  if (exact) return exact(req);
  for (const { pattern, handle } of dynamicRoutes) {
    const match = pattern.exec(pathname);
    if (match) return handle(req, match);
  }
  return Response.json({ error: "Unknown worker operation" }, { status: 404 });
}
