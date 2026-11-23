# Implementation notes: inherited Pi Web and the OMP port

These notes were inherited through pi-web and omp-web and extended during this
fork's development. They are not a fresh specification of every branch. In
particular, a paragraph describing Pi's SDK is not automatically a valid
contract for the pinned `@oh-my-pi/*` SDK.

## Current OMP boundaries

- The application server runs on Bun. OMP's published SDK imports `bun:`
  built-ins; Node-only installation or testing instructions are not equivalent.
- `lib/omp-runtime.ts` owns the process-wide OMP `Settings`, `AuthStorage`, and
  `ModelRegistry`. `getSettingsForCwd()` scopes settings with `cloneForCwd()`.
  This is not upstream Pi's `ModelRuntime`/`SettingsManager` lifecycle.
- OMP credentials use its shared `agent.db`, not the upstream Pi `auth.json`
  storage described in inherited notes. Model definitions use `models.yml`;
  model roles and global settings use `config.yml`. See the root README and
  the OMP-specific sections of the models notes and ADR 0004.
- The browser's password/session credential store is separate from model-provider
  credentials. [Authentication](../authentication.md) and [HTTPS](../https.md)
  describe this fork's current login and deployment boundary.
- OMP-native tools, extensions, subagents, MCP, trust, and event lifecycles must
  be checked against the pinned SDK and the browser adapter. An inherited Pi
  built-in profile, command, settings path, or private API is not a promise that
  the OMP implementation uses it.

Do not mechanically rename `.pi` paths, `pi-web:` persisted identifiers, global
symbols, or SDK imports. Some are intentional compatibility contracts. Check
the actual route and SDK adapter before changing either code or its notes.
Unqualified issue numbers in inherited text refer to their original upstream
context; they are not necessarily issues in `flowtender/omp-web`.

## Note map

| Notes | How to use them |
| --- | --- |
| [Sessions](sessions.md) | Mixed inherited session/UI notes and OMP event fixes; check SDK-sensitive lifecycle claims against the OMP wrapper |
| [Models](models.md) | OMP additions plus inherited Pi defaults/auth descriptions; the boundaries above take precedence over Pi storage examples |
| [Tools](tools.md) | Inherited tool/resource policies; verify OMP-native loadout and extension APIs |
| [Subagents](subagents.md) | Inherited Pi subagent design and OMP-specific additions; not a list of OMP's current built-in profiles |
| [Settings UI](settings-ui.md) | Shared UI patterns and OMP settings-refresh notes; inherited Pi settings-file examples are source context |
| [Files and access](files-and-access.md) | Shared project/file behavior and inherited web-auth notes; use the authentication guide for current login behavior |
| [Browser and mobile](client-platform.md) | Shared client-side behavior; SDK event names still need OMP verification |
| [MCP listing/writes](mcp-settings.md) | Inherited Pi MCP configuration/editor contracts |
| [MCP add](mcp-add.md) | Inherited Pi import syntax and trust decisions |
| [MCP runtime](mcp-runtime.md) | Inherited Pi MCP connection architecture |
| [MCP testing/sign-in](mcp-test-sign-in.md) | Inherited Pi transport/auth contracts and isolated-test guidance |

MCP notes retain design history, not an assertion that OMP exposes Pi's private
MCP modules. Prefer the OMP SDK's supported services rather than implementing
an inherited private-module adapter solely because these notes describe one.

For branch scope, PR recipients, review checkpoints, and SDK compatibility
updates, use [upstream maintenance](../upstream-maintenance.md). For runtime
verification, use the tests and source on the branch being changed; neither a
historical ADR's “Accepted” status nor a successful upstream Pi test proves
compatibility with OMP.
