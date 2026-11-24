# Documentation for flowtender/omp-frond

This repository is a fork of [KD-MM2/omp-web](https://github.com/KD-MM2/omp-web).
It tracks [ddallabenetta/omp-web](https://github.com/ddallabenetta/omp-web) and the original [agegr/pi-web](https://github.com/agegr/pi-web). It embeds the
Oh My Pi SDK from [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi); it is not the original Pi Web application
or proof of a new release of the upstream `omp-web` npm package.

## Start here

- [Fork overview and source installation](../README.md)
- [Contributing and choosing the PR recipient](../CONTRIBUTING.md)
- [Upstream streams, branch roles, SDK upgrades, and GitHub automation](upstream-maintenance.md)
- [Release ownership and deliberate publication](release.md)

`main` contains the existing mixed application history and maintenance docs.
`integration` is the separately adapted SDK baseline; `daily` preserves the
complete application with pending features. Historical `topic/*` tips are
stacked, not independently extracted PRs. Read the maintenance guide before
merging, rebasing, or submitting them. These branch roles do not mean every
feature described in this directory exists on every branch.

## Running the application

| Guide | Scope |
| --- | --- |
| [Authentication](authentication.md) | Browser login, cookies, password recovery, API access |
| [HTTPS](https.md) | Native TLS and reverse proxies |
| [Docker](docker.md) | Building this checkout and sharing the OMP data directory |
| [Terminal](terminal.md) | Terminal panel and its subprocess boundary |
| [Worktrees](worktrees.md) / [简体中文](worktrees.zh-CN.md) | Project/worktree behavior, not maintenance topic branches |
| [Project trust](project-trust.md) | Browser-specific trust decisions for executable project resources |
| [Internationalization](i18n.md) | UI language support and translation contributions |

## Translated entry points

- [简体中文](README.zh-CN.md)
- [日本語](README.ja.md)
- [Русский](README.ru.md)
- [简体中文贡献指南](CONTRIBUTING.zh-CN.md)

The English README and maintenance guide are the canonical fork instructions.
Translated quickstarts must identify the same repository and Bun runtime;
installing `@agegr/pi-web` is not an installation of this fork.

## Implementation notes and decisions

The files under [agents/](agents/README.md) combine inherited pi-web design notes
with OMP-specific changes. They are maintenance references, not independent
installation instructions or a promise of compatibility with today's Pi SDK.
The [implementation-note index](agents/README.md) explains how to interpret
inherited config paths, symbols, issue numbers, and runtime assumptions.

Architecture decisions are retained as design history:

- [0001: Project command environments](adr/0001-isolate-project-command-environments.md)
- [0002: Chat-only tool selection](adr/0002-chat-only-tool-selection.md)
- [0003: Built-in subagent toggle](adr/0003-built-in-subagent-toggle.md)
- [0004: Enabled-model switches](adr/0004-enabled-models-toggles.md)
- [0005: Built-in subagent disable](adr/0005-built-in-subagent-disable.md)
- [0006: MCP and Code mode](adr/0006-mcp-and-code-mode.md)

Pi-specific names and original decisions in inherited ADRs describe their source
context. They do not override OMP's current SDK contracts or this fork's
maintenance policy. Retain upstream attribution and intentional compatibility
identifiers rather than mechanically renaming `pi` to `omp`.
