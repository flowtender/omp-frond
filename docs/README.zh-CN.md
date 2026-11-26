# omp-web

[English](../README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

[oh-my-pi（omp）](https://github.com/can1357/oh-my-pi) 编码智能体的浏览器界面。omp-web 读取 `omp` CLI 已经写入的会话，在浏览器中提供会话浏览、实时对话、模型角色、Provider 配置、技能管理和项目文件预览。

本仓库 `flowtender/omp-frond` 是 omp-web 的 fork，界面源自 [pi-web](https://github.com/agegr/pi-web)（作者 [@agegr](https://github.com/agegr)），并包含 [ddallabenetta/omp-web](https://github.com/ddallabenetta/omp-web) 与 [KD-MM2/omp-web](https://github.com/KD-MM2/omp-web) 的 OMP 适配。OMP SDK（[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)）以精确版本号作为依赖锁定。分支结构和更新流程见英文文档 [docs/upstream-maintenance.md](./upstream-maintenance.md)。

## 快速开始

omp-web 的 API 运行在 **Bun** 上，因为 omp SDK 以 TypeScript 源码发布，并导入 `bun:` 内置模块。环境要求：**Bun 1.4.4 或更高版本**，以及 **Node.js 22.19.0 或更高版本**（见 `package.json` 的 `engines`；安装时的 `postinstall` 步骤使用 Node 运行）。

### 从源码运行（本分支）

本仓库的源码检出即为本分支的构建方式：

```bash
git clone https://github.com/flowtender/omp-frond.git
cd omp-frond
bun install
bun run dev                      # 开发服务器：http://127.0.0.1:30141
```

如需从源码检出运行生产版本，先构建再启动：`bun run build`，然后 `bun run start`（监听 `127.0.0.1:30141`；`bun run start:lan` 绑定 `0.0.0.0`）。同一检出目录中 `bun run dev` 运行时不要构建，两者都使用 `.next/`。

### 上游 npm 包

npm 上的 `omp-web` 包由上游 [ddallabenetta/omp-web](https://github.com/ddallabenetta/omp-web) 发布，其 `package.json` 也指向该仓库。它不能证明本分支已发布到 npm，也不包含本分支的改动。只有想使用上游发行版时才需要：

```bash
bunx omp-web@latest
```

全局安装：

```bash
bun add -g omp-web    # 或：npm install -g omp-web
omp-web
```

服务就绪后，CLI 会尝试自动打开浏览器；否则访问 [http://127.0.0.1:30141](http://127.0.0.1:30141)。CLI 默认只监听 `127.0.0.1`。如果尚未配置模型 Provider，请打开 **Models** 面板登录或添加 API Key。`omp-web` 入口本身在 Node 或 Bun 下运行，并会找到 Bun 后在其中重新执行服务，可通过 `OMP_WEB_BUN=/path/to/bun` 指定 Bun 路径。

Windows 上如果 `bunx` 在启动前因 `EPERM: Operation not permitted (NtSetInformationFile())` 失败，问题出在 Bun 的 Windows 缓存重命名环节，而不是 omp-web。可以升级 Bun 后清空缓存重试。

## 常用选项

命令行参数优先于对应的环境变量。

```bash
omp-web --port 8080              # 自定义端口
omp-web --hostname 0.0.0.0       # 在可信网络中对外开放
omp-web --no-open                # 不自动打开浏览器
omp-web --authenticated          # 启用密码（尚未设置时会在终端提示输入）
omp-web --reset-password         # 忘记密码时设置新密码
```

| 参数或环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `--port <端口>`、`-p`，或 `PORT` | 服务端口 | `30141` |
| `--hostname <主机>`、`-H`，或 `OMP_WEB_HOSTNAME` | 监听地址 | `127.0.0.1` |
| `--no-open`，或 `OMP_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `--authenticated`，或 `OMP_WEB_AUTHENTICATED=1` | 启用密码锁 | 关闭 |
| `OMP_WEB_PASSWORD` | 覆盖已保存的密码 | 未设置 |
| `OMP_WEB_ALLOWED_HOSTS` | 额外允许的精确主机名（反向代理使用），多个值用逗号分隔 | 未设置 |

HTTPS 使用 `--tls-cert cert.pem --tls-key key.pem`。详见 [HTTPS](./https.md)。

## 密码与访问

在 **Settings → Access** 中设置密码并开关密码锁；也可以使用 `--authenticated`，或设置 `OMP_WEB_PASSWORD`。密码以 `scrypt` 哈希保存在 `~/.omp/agent/omp-web-auth.json`（权限 `0600`）中。忘记密码时，在服务器上运行 `omp-web --reset-password`，或打开 `/recover` 并输入服务器控制台打印的一次性验证码。

omp-web 可以调用高权限的智能体，请用 [原生 HTTPS](./https.md)、可信的 HTTPS 反向代理或可信 VPN 保护登录密码和会话 Cookie。完整的威胁模型见 [authentication.md](./authentication.md)。

## 模型角色

omp 为不同工作范围配置不同的模型。omp-web 展示的角色与 TUI 中 `/model` 选择器和 `Ctrl+P` 循环使用的角色相同，包括 `default`、`smol`、`slow`、`plan`、`commit`、`task`、`advisor`、`vision`、`designer` 和 `tiny`。

角色分配写入 `~/.omp/agent/config.yml` 中的 `modelRoles`（选择 **This project** 时写入 `.omp/config.yml`）。在浏览器中做出的分配，也是下一次终端会话启动时读取的配置。

## HTTP 代理

服务端的模型和 API 请求读取标准的 `HTTP_PROXY` 与 `HTTPS_PROXY` 环境变量，Bun 仅在进程启动时读取一次，因此需要在启动前设置：

```bash
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 bunx omp-web@latest
```

回环地址的请求不会走代理，因此本地 Provider（Ollama、LM Studio、llama.cpp）即使配置了代理也能使用。注意 Bun 目前不遵守其他主机的 `NO_PROXY`。

## 注意事项

- **数据目录**：默认读取 `~/.omp/agent/sessions`。设置 `PI_CODING_AGENT_DIR` 可以指向其他 omp agent 目录（变量名沿用 omp 的命名）。
- **会话文件**：`~/.omp/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`。
- **Provider 配置**：Models 面板读写 agent 目录中的 `models.yml`；凭据保存在 omp 的 `agent.db` 中，与 CLI 共享。
- **项目信任**：`.omp/extensions`、`.omp/hooks`、`.omp/tools` 和 `.mcp.json` 需要明确信任后才会执行，见 [项目信任](./project-trust.md)。
- **文件访问范围**：文件浏览和预览限于所选项目目录以及会话中出现的工作目录。
- **Git worktree**：切换器何时显示、如何创建和删除，见 [worktree 说明](./worktrees.zh-CN.md)。
- **国际化**：见 [国际化](./i18n.md)。

## 功能

- **继续之前的工作**：按项目浏览 omp 会话，无需翻找终端历史或会话路径。
- **按角色路由模型**：为不同工作范围分配并切换模型。
- **安全地尝试不同方向**：从较早的消息继续，或把会话分叉到独立路线。
- **在分支之间切换**：从侧边栏切换 Git worktree。
- **与项目并排对话**：在对话旁浏览、上传文件，并预览源码、文档、图片、音频和 PDF。
- **终端与对话并存**：在 Explorer 中打开所选目录的 shell。

## 开发

请在本仓库的源码检出中开发。需要 Bun 1.4.4 或更高版本，以及 Node.js 22.19.0 或更高版本。

```bash
git clone https://github.com/flowtender/omp-frond.git
cd omp-frond
bun install
bun run dev
```

开发服务器运行在 [http://127.0.0.1:30141](http://127.0.0.1:30141)。常用检查：

```bash
bun run typecheck
bun run lint
bun run test
```

日常开发时不要运行 `bun run build` 或 `next build`，它们会写入 `.next/`，可能干扰开发服务器；构建只在发布流程中执行。

开始做新功能之前，请先阅读[参与贡献](./CONTRIBUTING.zh-CN.md)，了解改动应提交到哪个仓库以及提交 PR 前的检查项。远程仓库、上游同步、提交流程和 SDK 升级的维护说明见英文主文档 [docs/upstream-maintenance.md](./upstream-maintenance.md)。

## 许可证

[MIT](../LICENSE)
