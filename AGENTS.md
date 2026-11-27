# omp-frond - Development Notes

## Quick Start

```bash
bun install
bun run dev   # port 30141
```

Typecheck: `bun run typecheck`
Lint: `bun run lint`
Tests: `bun run test`
**Never run `bun run build` during dev** — pollutes `.next/` and breaks `bun run dev`.
Exception: `bun run desktop:build` (via `scripts/stage-desktop.mjs`) is safe — it builds
into `src-tauri/server/.next` through `OMP_FROND_DIST_DIR` and never touches the dev `.next/`.

### Checking the UI in a browser without the password lock

The dev server on 30141 uses the real agent dir, so it is usually locked
(`omp-frond-auth.json`). For a visual check, run a second dev server on a throwaway
agent dir; it starts unlocked and never touches the real config:

```bash
AGENT_DIR=$(mktemp -d /tmp/omp-frond-verify.XXXXXX)/agent && mkdir "$AGENT_DIR"
NODE_ENV=development PI_CODING_AGENT_DIR="$AGENT_DIR" OMP_FROND_DIST_DIR=.next-verify \
  bun bin/next-with-worker.js dev --turbopack -H 127.0.0.1 -p 30142
```

- `PI_CODING_AGENT_DIR` moves both omp's agent dir and the password store
  (`bin/web-auth-store.js`). The empty dir means default settings: no sessions,
  no providers, omp's default `theme.light`/`theme.dark`.
- `OMP_FROND_DIST_DIR=.next-verify` keeps it off the main server's `.next/`. It is
  gitignored, and its `tsconfig.json` includes are already present, so Next does not
  rewrite that file. Use this name: another one makes Next add new includes there.
- `NODE_ENV=development` is required when the shell exports `NODE_ENV=production`:
  `next dev` then fails every CSS file with "Module parse failed: Unexpected character '@'".
- In dev, the Next "Compiling…" badge sits over the sidebar's Settings button and
  blocks clicks there; focus the button and press Enter instead.
- Stop the server and `rm -rf` the temp dir afterwards.

### Everything runs on Bun

`@oh-my-pi/pi-*` is published as **TypeScript sources** and imports `bun:sqlite`,
so Node cannot load it at all (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
The server half of omp-frond therefore only runs on Bun; `bin/omp-frond.js` finds a
Bun binary and re-executes `next start` through it.

Two consequences worth remembering:

- `next.config.ts` externalizes **every** `@oh-my-pi/*` request as an ESM
  `import`, not `commonjs`. The SDK's `exports` map declares only an `import`
  condition, so a `require()` of it cannot resolve — that is what
  "Cannot find module '@oh-my-pi/pi-coding-agent'" during *Collecting page data*
  means. `serverExternalPackages` alone is not sufficient: it misses the SDK's
  own transitive entry points.
- `bun test`, not `node --test`. The test files are `node:test`-based and Bun
  runs them; Node cannot import the SDK the tests exercise.
- `bun run test` runs `bun test --parallel`, which gives every file a fresh
  global. Under plain `bun test` all files share one process, and the SDK's
  agent dir (frozen at first load), the omp runtime and the allowed-roots
  caches leak from file to file. bunfig has no switch for that, hence the
  script. `bunfig.toml` preloads `scripts/test-preload.mjs`, which points
  `PI_CODING_AGENT_DIR` at a throwaway directory so no test touches the real
  `~/.omp/agent`. The project's `.omp/config.yml` adds a bash-interceptor rule
  that refuses `bun test` and points agents at `bun run test`.

---

## Architecture

```
Browser                Next.js Server (Bun)        AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/  │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK helpers and
`lib/session-reader.ts` — no AgentSession created.
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an
AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  sessions/prompt-cache/route.ts  GET prompt-cache status of every listed session, read off its transcript
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/[id]/form-media/[token]/[index]/route.ts  GET a picture of an open ask form
  agent/running/route.ts          GET currently-running session ids + live prompt-cache statuses
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth + API-key provider lists for the Models panel
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer | POST uploads
  home/route.ts                   GET user home directory
  model-roles/route.ts            GET/PUT omp's modelRoles record (candidates follow enabledModels)
  model-presets/route.ts          GET/POST/PUT/DELETE omp's modelPresets (saved in the global config)
  model-presets/activate/route.ts POST write a preset into the role setup + switch the open chat
  models/route.ts                 GET { models, modelList, defaultModel, roles }
  models/enabled/route.ts         GET/PUT enabledModels switches (minimal pattern edits) + new-model tags
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST omp plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  settings/route.ts               GET/PATCH omp settings (?cwd= or ?project=) | DELETE a project's own value
  settings/project-overrides/route.ts  GET which settings each project's own config sets on a tab
  web-access/route.ts             GET/PUT the password lock (settings -> Access)
  web-access/recovery/route.ts    POST recovery code request/redeem (unauthenticated)
  worktrees/route.ts              GET/POST/DELETE git worktrees
  push/config/route.ts            GET VAPID public key
  push/subscribe/route.ts         POST register a web-push subscription
  terminal/route.ts               POST create a shell terminal session
  terminal/[id]/route.ts          GET session info | POST input/resize | DELETE kill
  terminal/[id]/events/route.ts   GET SSE stream

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  session-draft-shared.ts  client-safe rules of a saved session's shared composer draft
  session-draft-sync.ts    keeps the composer draft in step with other devices (client)
  session-draft-store.ts   server store of each saved session's shared draft
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  form-dialog.ts       ask form: SDK parse -> browser shape, browser state -> form data, picture loading
  form-dialog-types.ts client-safe wire types of the ask form
  form-media.ts        ask form pictures: <img src> loader (10 MB cap, 10 s fetch timeout) + standalone <svg>
  file-upload-client.ts browser upload to /api/files, shared by explorer and chat drops
  markdown.ts          shared markdown helpers
  enabled-models.ts    pure minimal-edit editor for enabledModels patterns
  enabled-models-runtime.ts  omp SDK adapter for it: per-pattern resolution, config.yml read/write
  model-roles.ts       omp's model roles, read/written for the browser; the role candidate pool
  model-presets.ts     omp's model presets: list, create, edit, delete, activate into a scope
  model-preset-http.ts request helpers shared by the model-presets routes
  model-display-name.ts  short model name for the composer, copying the TUI status line's rule
  model-family.ts      a model's vendor read off its id, for the second icon on the model chip
  model-scope.ts       enabledModels resolution shared by UI and startup
  npx.ts               npx runner used by skill install
  omp-runtime.ts       shared Settings + AuthStorage + ModelRegistry
  omp-types.ts         structural view of omp's AgentSession
  project-trust.ts     gates a project's executable resources
  project-settings-file.ts  writes a project's .omp/config.yml (omp writes only model roles there)
  seen-models.ts       models already shown, for the "new" tags (omp-frond-seen-models.json)
  prompt-cache.ts      prompt-cache status: a live session's warmer, or inferred from a transcript
  prompt-cache-shared.ts  client-safe prompt-cache report, view-at-time and indicator settings
  cache-miss-markers.ts  omp's cache-miss marker per assistant entry (history routes + live message_end)
  transcript-notices.ts  client-safe shape of that marker on a chat message, its formatting and fold summary
  push-client.ts       browser push subscription helpers
  web-push.ts          VAPID keys + web-push notification sending
  rpc-manager.ts       AgentSessionWrapper + registry + startRpcSession
  session-reader.ts    session listing + path cache + buildSessionContext adapter
  session-system-prompt.ts  SYSTEM.md / APPEND_SYSTEM.md resolution per session cwd
  session-title.ts     thin wrapper over omp's own title generator
  terminal-client.ts   browser side of /api/terminal (create, input, SSE)
  terminal-manager.ts  server-side PTY sessions with connection leases
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AccessConfig.tsx    password lock panel inside the settings modal
  FormDialog.tsx      the ask tool's HTML form, drawn natively (ui.formDialog)
  SettingsScopePicker.tsx  "Edit for": global or one project, on project-scoped settings tabs
  PromptCacheIndicator.tsx  the cache marker (composer + sidebar rows), per the Appearance settings
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/role/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for providers/auth (opened from sidebar bottom)
  ModelRolesConfig.tsx Settings › Model roles: current roles + presets list (draft, Apply; Activate per row)
  ModelRoleRows.tsx   per-role model picker + thinking strip, shared by roles and preset drafts
  PromptCacheLossDialog.tsx asks before a model/thinking/reload change discards a warm prompt cache
  EnabledModelsSection.tsx per-model enabledModels switches + controller hook + new-model badge
  PluginsConfig.tsx   modal for installed omp plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TerminalPanel.tsx   terminal tab in the right-hand file panel
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useSessionReload.ts settings panels' session reload, asking first while the chat's cache is warm
  usePromptCacheIndicator.ts  prompt-cache marker settings (localStorage)
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
  useTerminalTheme.ts terminal's own dark/light choice (localStorage)
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__ompSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__ompStartLocks`)
- Extensions are bound with omp's own `initializeExtensions()` from
  `@oh-my-pi/pi-coding-agent/modes/runtime-init` — the same wiring `omp --mode rpc`
  uses — with a browser-backed `ExtensionUIContext` layered on top. Do not
  reimplement the action set; a mismatch shows up as extensions silently doing
  nothing.

### One runtime, many requests (`lib/omp-runtime.ts`)
omp's CLI builds `Settings` + `AuthStorage` + `ModelRegistry` once per process.
omp-frond does the same and caches them on `globalThis`; a second `AuthStorage`
would open a second SQLite handle on `~/.omp/agent/agent.db` and split
`credential_disabled` events. Per-project settings come from
`settings.cloneForCwd(cwd)`, never from a second `Settings.init()`.

Anything that mutates credentials or `models.yml` must call
`refreshOmpRuntime()` as well as `invalidateModelsCache()`: it reloads the shared
registry in place, which live sessions hold. `invalidateOmpRuntime()` replaces the
whole runtime and strands those sessions on the old registry, so reserve it for
changes the registry cannot reload (plugins).

### Model roles are the model selector
omp assigns a model per scope of work (`default`, `smol`, `slow`, `vision`,
`plan`, `designer`, `commit`, `tiny`, `task`, `advisor`), stored in the
`modelRoles` record in `config.yml`. `lib/model-roles.ts` reads and writes that
record; `GET /api/models` ships the resolved table so `ChatInput` can list roles
above the flat model list, and `set_role_model` switches the session **and
records the role** so the transcript matches what `/model` writes in the TUI.

An explicit model pick in the browser is persisted as `modelRoles.default`
(`lib/startup-preferences.ts`), which is the same slot the TUI writes.

Settings › Model roles edits both the live role setup and omp's model presets
(`modelPresets.<name>`; see `docs/agents/models.md`, Model roles and presets).
Role candidates follow the Models tab's `enabledModels` filters for chat models;
non-chat runners stay listed (omp's `scopedRolePool`).

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is display metadata only. When reparenting a surviving child on delete, replace its transcript atomically; an in-place rewrite can truncate its chat history.

### `SessionManager.open()` is async
Every omp `SessionManager.open()` / `forkFrom()` / `continueRecent()` returns a
Promise, and `setSessionName()` / `newSession()` / `flush()` do too. Forgetting
an `await` yields `Property 'getEntries' does not exist on type 'Promise<…>'`.

### Transcript ordering follows omp, not the LLM context
`buildSessionContext()` in `lib/session-reader.ts` mirrors omp's live-chat
transcript (`{ transcript: true, collapseCompactedHistory: true }`): history
replaced by the latest compaction is elided, and the summary renders **at the
chronological compaction point** — after the kept messages, before the
post-compaction turns. It is not the LLM context, where the summary comes first.
`entryIds` is a parallel array to `messages` and is walked locally because omp's
`buildSessionContext` does not return entry ids.

### ToolCall field normalization
omp stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### Tool settings and tool pins
There are no tool presets. Settings › OMP settings › Tools edits omp's own
Tools tab globally or for one project (`.omp/config.yml`, which wins in that
project); see `docs/agents/tools.md`. Tool names can still be passed at session
creation (`POST /api/agent/new` → `toolNames[]`) or with `set_tools`; the
browser sends neither. When tools are fully disabled (`toolNames = []`),
`rpc-manager.ts` passes `toolNames: []` with `restrictToolNames: true` and runs
the session as Chat only (ADR 0002).

### `enabledModels` scoping
The `enabledModels` setting uses omp's `--models` syntax: globs against
`provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and
an optional `:thinkingLevel` suffix. Never compare those patterns as literal
strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScope()` so
omp-frond and the TUI agree on the visible model list, and falls back to all
available models when patterns resolve to nothing. Diagnostics are produced by
re-resolving each pattern alone, because omp's resolver drops unmatched patterns
silently.

Settings › Models edits it through `/api/models/enabled` only, as a minimal edit
of the stored patterns (ADR 0004, `docs/agents/models.md`): writes go to the
global `config.yml` through the shared `Settings`, a project value or a
path-scoped global entry makes the switches read-only, and models first seen
since the last look are tagged "new" until switched or prompted with.

### Project trust is omp-frond's own
omp has no trust store — it runs a repository's extensions because you ran it
there. A browser tab is not that decision, so `lib/project-trust.ts` keeps a
store in `~/.omp/agent/omp-frond-trusted-projects.json` and, for an untrusted
project, filters project-local entries out of omp's discovered extension and
custom-tool paths and disables MCP. Skills and rules are data and always load.
See `docs/project-trust.md`.

### `SYSTEM.md` / `APPEND_SYSTEM.md` are resolved per session cwd
`omp` resolves both files before it creates a session and passes them as
`customSystemPrompt` / `appendSystemPrompt`. `startRpcSession()` builds its own
options, so `lib/session-system-prompt.ts` does the same for the browser: omp's
`findConfigFile` (never a hand-rolled lookup) project-first then user-level,
`resolvePromptInput` to read it, and omp's `applyResolvedSystemPromptInputs` to
set the fields — so the text goes through the same templates the CLI renders it
with. Every lookup is bound to the session's cwd, because the CLI's default
(`getProjectDir()`) is the server's own directory here, not the project's.
Project-local prompt files load for untrusted projects too: they are data, like
skills and rules (`docs/project-trust.md`).

### The `ask` tool is a form, drawn by `ui.formDialog` (SDK >= 18.18.3)
`ask` takes one HTML `<form>` (`{ html }`). A host without `ui.formDialog` gets the
SDK's field-by-field fallback through `select`/`input`/`editor`, which loses the
model's preselections and checkbox state in the browser, so `rpc-manager.ts`
implements `formDialog` and `components/FormDialog.tsx` draws the form.

- The server parses the HTML with the SDK's own `parseHtmlForm` and ships a reduced
  shape (`lib/form-dialog-types.ts`): no raw HTML reaches the browser, so nothing the
  model writes can run there. `<svg>` and `<img>` become numbered `media` blocks.
- Pictures come from `GET /api/agent/[id]/form-media/[token]/[index]`: the server loads
  them with `lib/form-media.ts` (URL, data URI, or a path resolved from the session cwd
  by the SDK's `resolveReadPath`; 10 MB cap, 10 s fetch timeout) and serves bytes with a
  sandboxing CSP. SDK 19.2 has no exported loader: its form's own (`ui/forms/html-form/media.ts`)
  registers pi-tui blobs and rasterizes SVG for the terminal, while the browser draws SVG
  itself. The browser never contacts a host the model chose. The token exists only while
  the dialog is open.
- The browser answers with its raw control state (`FormDialogState`); the server turns
  it into form data with the SDK's `choiceValue`/`textValue`, so the TUI and the
  browser agree on what a form submits. As in the TUI (SDK >= 19.2), rules never block
  Submit: the form is `noValidate`, and once the user leaves a field its broken answer
  is flagged (the browser's constraint message for text, a required check for choice
  groups) but still sent.
- `ask.timeout` is the user's setting; unset, the form is not timed. When set, the
  browser submits its live values at the deadline (`timedOut`); the server's timer
  runs `FORM_TIMEOUT_GRACE_MS` later and submits the form's defaults if no browser
  answered.
- `form` is a blocking request (`lib/extension-ui-queue.ts`), like `select` and
  `input`, so a parked form raises the attention notification.
- The older `askDialog` / `method: "ask"` path stays for extensions that call
  `ui.askDialog`; the `ask` tool no longer uses it.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer omp emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- An open chat follows a run another device started through the same running poll (`sessionRunning` → `runHintAction()` in `lib/session-run-hint.ts`): it reloads history, then `ensureEventsConnected()`. Opening an idle chat opens no stream. A fast run that starts and ends between two polls is caught through the selected row's `modified`/`messageCount`, which the running poll's list reload merges into the open chat; that reloads an idle chat's history. The first observation after mount does nothing, because the mount's own load already handles a run in progress.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### Plugins and skills
- `/api/plugins` lists and toggles pi's package list: the `packages` key of `~/.omp/agent/settings.json` (global scope) and of the project's own `settings.json` (`.omp/`, falling back to a legacy `.pi/`). A package is disabled by emptying its four resource lists, and enabling restores the entry minus those lists, so `autoload` and hand-written filters survive a toggle (`lib/plugin-package-settings.ts` owns that storage; omp's own `Settings` has no package list).
- `/api/plugins` install/remove/update still drive omp's `PluginManager` (`~/.omp/plugins`), which has no in-place update, so "update" reinstalls the spec with `force`. `canCheckForUpdates` comes from `lib/plugin-updates.ts`, and `npm:` sources resolve their install under `~/.omp/plugins/node_modules`.
- Top-level modules under `~/.omp/agent/extensions` (and a trusted project's `.omp/extensions`) are reported as `standaloneExtensions`, `enabled` following omp's own `disabledExtensions` ids (`extension-module:<name>`) from `settings.json`/`config.yml`. Project-scope writes need an explicit trust decision even when the folder only ships a `settings.json`, which omp-frond's session gate alone would wave through.
- `/api/skills` uses omp's own `loadSkills()`, so `.omp/skills`, `~/.omp/agent/skills`, `.claude/skills`, plugin skills and `.agents/skills` are listed exactly as a session sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent claude-code`. The `skills` CLI has no `omp` agent, and its `pi` agent writes `~/.pi/agent/skills`, which omp does **not** read; the Claude layout is discovered by default.

### Auth and model config
- Credentials live in omp's SQLite `agent.db` via `AuthStorage`, not in `auth.json`. Writes go through `authStorage.set()` / `remove()` / `logout()` so the CLI and omp-frond share one store and one lock.
- Provider listing is capability-driven: `lib/provider-listing-runtime.ts` folds the catalog (`@oh-my-pi/pi-catalog`), the OAuth registry (`@oh-my-pi/pi-ai/oauth`) and stored credential types into the flat shape `lib/provider-listing.ts` expects, so a dual-auth provider appears exactly once. An OAuth login whose `storeCredentialsAs` differs from its id is keyed by the id the catalog uses.
- OAuth flows are streamed by `GET /api/auth/login/[provider]` through `authStorage.login()`; `onAuth`/`onPrompt`/`onManualCodeInput` become browser input requests with short-lived tokens stored in `globalThis.__ompLoginCallbacks`.
- API-key status endpoints must never return the raw key.
- `models.yml` is YAML: `/api/models-config` parses whichever of `models.yml` / `models.yaml` / `models.json` exists and always writes back `models.yml`.
- A header value in `models.yml` that names an environment variable is written as the **bare name** (`X-Token: MY_VAR`), not `$MY_VAR`.

### Password access is verified in the proxy, stored hashed, and shared with `bin/`
`bin/web-auth-store.js` is the single source of truth for the password lock, and
it is CommonJS in `bin/` on purpose: the launcher needs it before Bun is even
resolved, and `bin/` is the only directory (besides `.next`) in the published
npm `files` list, so `lib/` cannot hold it. `bin/web-auth-store.d.ts` is what the
TypeScript half type-checks against — keep the two in sync.

- The password is stored **only** as a scrypt digest in
  `<agentDir>/omp-frond-auth.json` (`0600`, atomic replace). Nothing can read it
  back, which is why `/recover` and `--reset-password` exist.
- `proxy.ts` runs on Next.js 16's Node.js runtime (proxy always does), so
  `node:fs` and `node:crypto` are available there. Do **not** import the omp SDK
  into it — `next.config.ts` only externalizes `@oh-my-pi/*` for the server
  build, and the SDK cannot be bundled. That is why the store re-derives the
  agent directory instead of calling `getAgentDir()`.
- `resolveWebAuthPolicy()` distinguishes a missing credential file (unlocked)
  from an unreadable one (`unavailable` -> 503). Never collapse those: the
  second one failing open would silently unlock the server.
- Successful verifications are cached for five minutes keyed by the digest that
  accepted them, because scrypt runs on every request otherwise. The key
  includes the digest, so a password change invalidates the cache across
  bundles.
- `/recover` and `POST /api/web-access/recovery` are the only unauthenticated
  paths. They still go through the host allow-list and cross-site checks, and
  the recovery code is printed on the server's stdout, never returned in the
  response.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `omp-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to omp's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

### HTTP proxying
Bun's `fetch` reads `HTTP_PROXY` / `HTTPS_PROXY` **once at process start** and
never proxies loopback — which is what local providers need. It ignores
`NO_PROXY`. `lib/http-dispatcher.ts` is therefore a no-op under Bun; its undici
`EnvHttpProxyAgent` path only exists for a dev server run on Node, because Bun
resolves `undici` to its own shim where `setGlobalDispatcher` does not affect
`fetch` and `install` does not exist.

## Old Safari (iOS 16.2)

- `/` renders entirely on the client, so one script chunk the browser cannot parse is a blank page. Next 16 targets Safari 16.4+; the `browserslist` in `package.json` lowers Safari and iOS to 16.2 so SWC turns class `static {}` blocks into private static fields. That covers Next's client runtime; other node_modules keep their syntax unless listed in `transpilePackages` (mermaid and `@mermaid-js/parser` are, for their lazy diagram chunks). Keep the other browserslist entries at Next's defaults.
- Never write a RegExp lookbehind (`(?<=`, `(?<!`) in client code: SWC cannot downlevel it and Safari parses it only from 16.4. `lib/markdown.ts` emulates its leading lookbehinds with `replaceNotPrecededBy()`. A lookbehind built at runtime (`new RegExp("(?<=…)")` in `try`) fails only when run; that is how `lib/gfm-autolink-email-loader.cjs` fixes `mdast-util-gfm-autolink-literal`'s email regex. The loader is registered for webpack and Turbopack in `next.config.ts` and fails the build if that regex changes upstream.

## omp Session File Format

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"model":"anthropic/claude-sonnet-5","role":"default","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`model_change` carries a `provider/modelId` string plus the **role** it came
from; `SessionContext.models` is a role → selector record, and `models.default`
is what the UI shows as the session's model.

---

## CSS Variables (`app/globals.css`)

Both themes come from omp's own theme files — `titanium` (omp's default dark
theme) and `light` — so the browser and the TUI read as one product.

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --accent-hover --user-bg --assistant-bg --tool-bg --bg-subtle
--success --danger --warning
--font-mono
```

`--font-mono` is a system stack on purpose: a local-first tool must not fetch a
font from a CDN at build or at runtime.

## choosing when to use gitnexus

for a local change with known callers, use the language server for definitions, references, and renames. verify the affected behavior with focused tests. a graph query is not a prerequisite to editing or committing.

use the gitnexus cli when tracing an unfamiliar flow across components, changing a shared contract, or planning a refactor whose callers are unclear. from the repo root, use `gitnexus list` to confirm the checkout and `gitnexus status` to check index freshness. use `gitnexus query` to find flows and `gitnexus impact` to find callers worth inspecting; confirm the relevant paths in source. a high risk rating is a reason to inspect those paths, not a verdict on the proposed change. zero callers or an unknown rating is not proof that nothing depends on a symbol.

this project policy takes precedence over workflow rules in generated gitnexus notes and skills. refresh the index with `node .gitnexus/run.cjs analyze --index-only` unless you intend to regenerate those files.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **omp-frond**.

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/omp-frond/context` | Codebase overview, check index freshness |
| `gitnexus://repo/omp-frond/clusters` | All functional areas |
| `gitnexus://repo/omp-frond/processes` | All execution flows |
| `gitnexus://repo/omp-frond/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
