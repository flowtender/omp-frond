# Project trust in omp-frond

## Why omp-frond has a trust gate and `omp` does not

The `omp` CLI loads a repository's `.omp/extensions`, `.omp/hooks`, `.omp/tools`
and `.mcp.json` as a matter of course. You ran `omp` inside that repository, which
is itself the decision to execute it.

omp-frond reaches the same code from a browser tab. Clicking a project in the
sidebar — or having a session for it restored on page load — would otherwise
import and run repository-controlled code on the machine hosting the server,
without anything that reads as consent. So omp-frond keeps a trust store that omp
itself has no need for. The SDK's tool-call approval comes too late for this:
the SDK imports custom tool modules and calls their factories before it can ask
whether to run a tool call.

## What requires trust

Only resources omp *executes*:

| Kind | Paths |
| --- | --- |
| Extensions | `.omp/extensions`, `.pi/extensions`, `.claude/extensions`, `.agents/extensions`, `.codex/extensions` |
| Hooks | the `hooks/` directory and `hooks.json` under each of those config roots |
| Custom tools | the `tools/` directory under each of those config roots |
| MCP servers | `mcp.json`, `.mcp.json`, `.omp/.mcp.json`, `.omp/mcp.json`, `.pi/mcp.json`, `.claude/.mcp.json`, `.claude/mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.windsurf/mcp_config.json`, and MCP entries in `.gemini/settings.json` |

The inventory also checks extension entries in `.omp/config.yml` and
`.omp/config.yaml`, and extensions, packages, enabled plugins and hooks in
`settings.json` under `.omp`, `.pi` and `.claude`. It checks from the chat's
working directory up to the checkout root. The dialog lists the paths without
running the resources. The MCP detail panel groups previews by source file and
masks credentials. It flags references to host credentials, possible
replacement of a same-named user server, and files it could not inspect.
The SDK can still read some files the preview skips after you trust the project.

Skills, rules, prompts and `AGENTS.md` are **not** gated. They are data folded
into the system prompt, not modules the loader imports, and gating them would
break ordinary projects for no gain in execution safety. They remain a prompt-
injection surface, exactly as they are in the CLI.

That explicitly includes a project's `SYSTEM.md` and `APPEND_SYSTEM.md`
(`lib/session-system-prompt.ts`): omp-frond resolves them for a browser session
the way `omp` resolves them for a terminal one, trusted project or not. Gating
them would also be a boundary in name only — a project carrying nothing but
`.omp/APPEND_SYSTEM.md` never requires trust in the first place.

A project with none of the executable resources above never sees a prompt:
`requiresTrust` is false. Empty tool directories do not count.

## What the gate actually does

When you open a new or saved chat, including one from the OMP TUI or Tern,
omp-frond asks for a decision if it finds executable project resources and
there is no permanent decision:

- **Trust for this chat** loads project resources for this opening only.
- **Don't trust for this chat** keeps them disabled for this opening only.
- **Always trust** allows project resources for future chats, including
  resources added later.
- **Never trust** keeps project resources disabled for future chats.

Closing the dialog without choosing leaves the transcript readable but does not
allow the worker to start or continue a live agent for the chat.

In restricted mode, omp-frond skips project executable discovery and hands
`createAgentSession`:

- `preloadedExtensionPaths` — extensions discovered using user settings
- `preloadedCustomToolPaths` — user-level tools, excluding project tools
- `mcp.enableProjectConfig: false` — the SDK does not load MCP servers from
  project manifests

User-level extensions and tools in `~/.omp/agent` keep working throughout, so an
untrusted project is a *narrowed* session, not a crippled one.

To change the decision, click **Restricted mode** in the chat or, for a trusted
chat, **Project resource permissions** in the project's sidebar menu.
A change does not interrupt another client's live run. If the transcript has an
idle agent under the opposite policy, the worker replaces it before the next
live operation.

## What a permanent decision covers

omp-frond trusts a **Git repository**, not whichever folder the chat happens
to open in. **Always trust** and **Never trust** apply to the repository's
canonical root, subdirectories and registered linked worktrees. A separate
repository nested inside a trusted directory needs its own decision. Outside
Git, the decision applies only to the folder shown, with symlinks resolved.

The OMP SDK's resource lookup answers a different question: what can this
session load? For example, the SDK walks up to find project rules, but its
native `.omp/tools` and MCP loaders check paths at the working directory.
Those lookup rules do not grant consent or determine where frond stores it.
Using the repository boundary lets chats in the same repo share a decision
without extending that decision to unrelated checkouts.

## Where the decision is stored

The worker keeps **for this chat** decisions in memory, not in the transcript.
Reopening a chat asks again if the checkout has executable resources and no
permanent decision.

Permanent decisions are stored on the worker in
`~/.omp/agent/omp-frond-project-decisions.json` by default, or in the configured
agent directory. The old `omp-frond-trusted-projects.json` or
`pi-web-trusted-projects.json` allow-list is not used for these decisions.
The file is written `0600` through the same atomic-replace helper used for
credentials. Deleting an entry clears that permanent decision; deleting the
file clears all permanent decisions.

## Relationship to the CLI

The store is omp-frond's own. Trusting a project in the browser does not change
what `omp` does in a terminal — the CLI already loads everything — and running
`omp` in a project does not mark it trusted for the browser.
