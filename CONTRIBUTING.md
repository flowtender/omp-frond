# Contributing to omp-web

[中文](./docs/CONTRIBUTING.zh-CN.md)

This repository, `flowtender/omp-frond`, is a fork of omp-web, the browser front end for the [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) coding agent. Its UI descends from [pi-web](https://github.com/agegr/pi-web). There are three UI upstreams, so decide which repository should receive a change before you write it.

## Where a change belongs

- **Fixes and docs for this fork** (`flowtender/omp-frond`): open an issue or pull request here. Open an issue first for anything larger than a bug fix.
- **OMP-based UI features**: these are prepared against the `main` branch of the recipient repository, either [ddallabenetta/omp-web](https://github.com/ddallabenetta/omp-web) or [KD-MM2/omp-web](https://github.com/KD-MM2/omp-web). Follow that repository's own contribution rules. A patch that works in this fork is not proof that it works on another recipient's baseline.
- **Changes to the original pi-based UI** that do not depend on OMP: propose them to [agegr/pi-web](https://github.com/agegr/pi-web), and follow its [CONTRIBUTING.md](https://github.com/agegr/pi-web/blob/main/CONTRIBUTING.md). That document's scope rules govern submissions to pi-web, not to this fork.
- **OMP SDK behavior** (sessions, tools, prompts, retries, or SDK APIs): report it to [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). This repository consumes the SDK as an exact pinned package.
- **SDK version changes**: a version bump is not proof of compatibility. SDK upgrades follow the process in [docs/upstream-maintenance.md](./docs/upstream-maintenance.md).

## Before you open a pull request

- **For a feature, open an issue first** that describes the use case and confirms the change fits the repository you are targeting.
- **Keep it to one change per pull request.** Split unrelated fixes into separate pull requests.
- **For a bug fix, explain how to reproduce it** on the base branch and why the change fixes the cause rather than a symptom.
- **Run the checks:** `bun run typecheck`, `bun run lint`, and `bun run test`. Do not run `bun run build` or `next build` during development (see [AGENTS.md](./AGENTS.md)). Do not run `bun test` without --parallel at all.
- **Translate new UI text.** Add new strings to every locale the app uses ([Internationalization](./docs/i18n.md)).
- **Read the relevant topic notes.** [AGENTS.md](./AGENTS.md) maps each area of the code to notes in `docs/agents/`. Read the notes for every file you change.
- **Avoid new runtime dependencies.** If one is needed, say why.

Maintainers who prepare submissions to upstream repositories follow the workflow in [docs/upstream-maintenance.md](./docs/upstream-maintenance.md). Contributors opening a pull request here do not need it.
