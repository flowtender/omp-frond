# gate project code before agent start

## status

accepted, 2026-11-27. supersedes the shared CLI trust policy described by [ADR 0006](0006-mcp-and-code-mode.md) for worker startup and project admission.

## context

The OMP SDK imports project tool modules and calls their factories before its tool approval policy runs. omp-frond starts agents on a worker from new chats and saved transcripts, including transcripts written outside omp-frond. A read-only transcript does not authorize code execution on that worker.

## decision

omp-frond inventories paths for project custom tools, extensions, hooks and MCP without loading project code. When a chat opens with executable resources and no standing decision, omp-frond asks the user to trust or distrust this opening, or always trust or distrust the project root. The worker checks project consent before admitting project code to a live agent. A per-opening choice is not a transcript property and does not authorize another opening. Permanent decisions are keyed to the canonical repository root and shared by its subdirectories and verified linked worktrees. A directory outside Git uses its own canonical path. The tool policy still governs individual calls after code is loaded.

## consequences

An empty executable-resource directory and a project with data-only skills, rules or prompts do not trigger a prompt. The worker does not carry forward old path-keyed trust as authorization for a wider repository. A permanent allow authorizes new or changed resources in that repository and its linked worktrees; the dialog names this scope before the user chooses it.
