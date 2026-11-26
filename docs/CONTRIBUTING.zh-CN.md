# 参与贡献 omp-web

[English](../CONTRIBUTING.md)

本仓库 `flowtender/omp-frond` 是 omp-web 的 fork。omp-web 是 [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) 编码智能体的浏览器前端，界面源自 [pi-web](https://github.com/agegr/pi-web)。这里涉及三个界面上游，所以动手前先确定改动应该提交到哪个仓库。

## 改动应该提交到哪里

- **本分支的修复和文档**（`flowtender/omp-frond`）：直接在这里开 issue 或 PR。较大的改动请先开 issue。
- **基于 OMP 的界面功能**：需要针对接收方仓库的 `main` 分支准备，接收方为 [KD-MM2/omp-web](https://github.com/KD-MM2/omp-web)。请遵循该仓库自己的贡献规则。在本分支能跑，并不代表在其他接收方的基线上也能跑。
- **不依赖 OMP 的原始 pi 界面改动**：请提交到 [agegr/pi-web](https://github.com/agegr/pi-web)，并遵循其 [CONTRIBUTING.md](https://github.com/agegr/pi-web/blob/main/CONTRIBUTING.md)。那里的范围规则适用于 pi-web，不适用于本分支。
- **OMP SDK 的行为**（会话、工具、提示词、重试或 SDK API）：请反馈到 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)。本仓库以精确锁定的包版本使用 SDK。
- **SDK 版本变更**：版本号变化不能证明兼容性。SDK 升级遵循 [docs/upstream-maintenance.md](./upstream-maintenance.md) 中的流程。

## 提交 PR 之前

- **新功能请先开 issue**，说明使用场景，并确认该改动适合目标仓库。
- **一个 PR 只做一件事**，不相关的修复请分开提交。
- **修 bug 时写清楚**如何在基础分支上复现，以及为什么这个改动修的是根因而不是症状。
- **运行检查**：`bun run typecheck`、`bun run lint`、`bun run test`。开发期间不要运行 `bun run build` 或 `next build`（见 [AGENTS.md](../AGENTS.md)）。
- **新增界面文字要做翻译**，应用支持的每种语言都要加上（见 [国际化](./i18n.md)）。
- **阅读相关的专题笔记**：[AGENTS.md](../AGENTS.md) 列出了代码各部分对应的 `docs/agents/` 笔记，改动哪些文件，就读哪些笔记。
- **尽量不引入新的运行时依赖**；确实需要时请说明理由。

负责向上游仓库准备提交的维护者，请遵循 [docs/upstream-maintenance.md](./upstream-maintenance.md) 中的流程。只向本仓库提交 PR 的贡献者不需要阅读它。
