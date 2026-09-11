# zDSH-Go

[English](README.md) | 中文

[![CI](https://github.com/zsagi1368/zDSH-Go/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/zDSH-Go/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%E2%89%A524-blue.svg)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-11-blue.svg)](package.json) [![Upstream](https://img.shields.io/badge/DeepSeek%20Harness-0.1.5--rc.2-purple.svg)](https://github.com/deepseek-ai/deepseek-harness) [![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#quick-start)

**zDSH-Go 是 [zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) 加上一项重大的上下文处理调整。** zDSH 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness 智能体框架）的增强分支。在 zDSH-Go 中，上下文缓存管理以核心源码级集成的方式落地，因此它不能以插件形态交付；zDSH 的其余部分保持原样。这里不出厂预装任何自研插件——自研插件经 zDSH 主线与其插件治理通道获取。

## zDSH 血缘链

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（官方）→ **zDSH**（[zsagi1368/deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH)：官方最新 + 自研插件套件 = 开箱即用版）→ **zDSH-Go**（本仓库：zDSH + 核心级上下文调整 = 上下文调整版）。

- zDSH-Go 的上游永远是 zDSH，绝不绕过 zDSH 直接同步官方仓库。
- 自研插件住在 zDSH 主线。zDSH-Go 只随附官方 in-tree 包（`plugin-governance`、`plugin-project-root`）以及 in-tree 的 Workbench 客户端，其余插件经治理通道安装（`pluginGovernance.install` 解析钉定的 npm 来源）。

| | 官方 DeepSeek Harness | zDSH（主线） | zDSH-Go（本仓库） |
|---|---|---|---|
| 定位 | DeepSeek AI 的上游 harness | 官方最新 + 自研插件套件 | zDSH + 核心级上下文调整 |
| 上下文处理 | 上游行为 | 上游行为 | 核心源码级集成（非插件） |
| 自研插件 | —— | 全套插件，经治理通道安装 | 不预装；经 zDSH 治理通道安装 |
| 治理数据兜底目录 | `~/.dsh` | `~/.dsh-zdsh` | `~/.dsh-zdsh-go`（与前两者互不冲突） |

> 上游 harness 处于 _开发者预览_ 阶段，正在快速迭代——未来将出现破坏兼容性的变更。运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

## 上下文调整改变了什么

调整直接落在核心源码上——agent loop、会话处理与投影、tools、token 计量、模型槽位、compaction、subagents——上下文缓存管理因此是核心行为的一部分，而不是外挂插件。具体表现：

- **核心级上下文缓存管理。** 核心拥有的每条请求路径都参与其中：agent loop、会话处理、tools、token 计量、模型槽位与 compaction 共享同一条缓存感知的上下文生命周期，而不是靠附加组件事后改造。
- **子代理 prompt 携带运行时上下文快照。** 每个子代理的初始 prompt 前置一个运行时上下文快照块，派生的 worker 与父级从同一份上下文事实出发。
- **fork 与团队成员不再预置 seed。** 团队与 fork 成员会话不再预置会话头——seed 留在它该在的地方，即父级。
- **上下文裁剪可观测。** 文件读取与搜索工具的结果暴露 `l3.pruning { bytes, prunable }` 元数据：裁剪字节数与可裁剪余量直接出现在工具输出里。
- **常驻预算门。** `scripts/verify-budget-table.ts` 已注册为验证门——开发者和 CI 在每次变更上校验 token 预算表的真实性。

<a id="quick-start"></a>

## 快速开始

### 前置要求

| | |
|---|---|
| Node.js | `^22.19.0 || >=24`（不支持 23.x） |
| pnpm | ≥ 11 —— 用 `corepack enable pnpm` 启用（或 `npm install -g pnpm`） |
| Git | 任意较新版本 |

### 安装

zDSH-Go 以源码形式分发。克隆仓库并运行对应平台的安装脚本——所有数据都收拢在仓库目录内：

```sh
git clone https://github.com/zsagi1368/zDSH-Go.git
cd zDSH-Go

# Windows (PowerShell 5.1+)
.\install.cmd
# macOS / Linux / WSL / Git Bash
./scripts/install.sh
```

安装脚本会检查前置条件，依次执行 `pnpm install --frozen-lockfile` 与 `pnpm run build`，并生成：

- `data/` —— 自包含数据主目录（`DSH_HOME`）。官方模块数据与 zDSH-Go 治理数据（插件注册表、审批账本，以及 `data/zdsh/` 下的已装插件）都保存在这里。
- `env.ps1` / `env.sh` —— 环境加载脚本，定义 `DSH_HOME`、`DSH_BRANCH_HOME`、`DSH_AGENTS_HOME`，以及指向已构建 CLI 的 `dsh` 命令。

<a id="run"></a>

### 运行

加载环境后，启动 Web UI：

```sh
# PowerShell
. .\env.ps1
# bash
source ./env.sh

dsh web
```

`dsh web` 默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。

<a id="run-from-source"></a>

也可以不经安装脚本，直接从检出版运行：

```sh
pnpm install
pnpm run build
pnpm dsh web
```

## 配置

安装是**自包含**的：所有数据都在 `<repo>/data` 内，默认不写仓库目录之外的任何位置。

| 变量 | 指向 | 默认值 |
|---|---|---|
| `DSH_HOME` | 数据主目录：官方模块数据 | `<repo>/data` |
| `DSH_BRANCH_HOME` | zDSH-Go 治理数据：插件注册表、审批账本、已装插件 | `<repo>/data/zdsh` |
| `DSH_AGENTS_HOME` | 官方 skills 主目录 | `<repo>/data/agents` |

**自定义数据目录** —— 在生成的 `env.ps1` / `env.sh` 中编辑 `DSH_HOME`（以及按需编辑 `DSH_BRANCH_HOME` / `DSH_AGENTS_HOME`）后重新加载。重新运行安装脚本会按仓库位置重新生成这两个文件，迁移位置后请重新指认。

治理数据根目录按如下顺序解析：显式 `DSH_BRANCH_HOME` → `<DSH_HOME>/zdsh` → 兜底主目录 `~/.dsh-zdsh-go`。仅当两个变量都未设置时才使用兜底目录，自包含安装永远不会触及它。它与主线的 `~/.dsh-zdsh` 刻意不同，这正是两套发行版可以在同一台机器上共存的原因。

## 更新与卸载

**更新：** 拉取本仓库默认分支的最新变更，然后重跑对应平台的安装脚本——它会以冻结 lockfile 重装依赖并重新构建。

**卸载：** 在仓库检出目录中运行对应平台的卸载脚本：

```sh
# Windows (PowerShell 5.1+)
.\uninstall.cmd
# macOS / Linux / WSL / Git Bash
./scripts/uninstall.sh
```

| 模式 | 行为 |
|---|---|
| 默认 | 移除检出版内所有被 gitignore 忽略的产物（`node_modules`、构建输出、`data/`、`env.ps1` / `env.sh`），恢复纯净检出版状态。可能被移除的用户本地文件（`.env`、`.claude/` 等）会先备份到临时目录，内含 `RESTORE.txt`。它从不触碰仓库目录之外的任何东西。 |
| `--purge`（PowerShell 为 `-Purge`） | 清理之后连整个仓库目录一并删除。 |
| `--clean-legacy`（PowerShell 为 `-CleanLegacy`） | 同时删除 zDSH-Go 主目录（`~/.dsh-zdsh-go`）与旧插件主目录（`~/.zdsh-workbench`、`~/.zdsh-plugin-center`）。主线数据目录 `~/.dsh-zdsh` **不会**被触碰。 |

`~/.dsh` 属于官方版本数据，可能存有与官方版本共享的数据——仅在显式交互确认后（或 `--yes` / PowerShell `-Yes`）才会删除。本脚本从不删除 `~/.agents`，仅在存在时报告。每次运行都会打印用户主目录的残留扫描。

## 安全

- **数据本地化** —— 自包含布局把官方模块数据、治理数据与已装插件都收拢在 `<repo>/data` 下。除非未设置 `DSH_HOME`（此时启用专属的 `~/.dsh-zdsh-go` 兜底目录），否则不写仓库目录之外的任何位置。
- **官方隔离** —— 官方版本数据位于 `~/.dsh`，zDSH-Go 的自包含布局从不写入；卸载脚本仅在显式确认后才会处理它，且从不删除 `~/.agents`。
- 运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

## 常见问题

**zDSH-Go 与 zDSH 主线是什么关系？** zDSH-Go 是 zDSH 加上一件事：以核心源码级集成落地的上下文调整。主线（[zsagi1368/deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) 的 `zdsh-latest` 分支）承载自研插件套件与上游跟踪；zDSH-Go 跟随主线，并在其之上重放上下文调整。两者独立安装、可以共存：zDSH-Go 的兜底主目录是 `~/.dsh-zdsh-go`，主线的是 `~/.dsh-zdsh`，两边的卸载脚本都不会触碰对方的数据。

**自研插件从哪里来？** 来自 zDSH 主线，经其插件治理通道——`pluginGovernance.install` 解析钉定的 npm 来源，并走带确认门的准入流程。zDSH-Go 本身不随附任何预装插件；in-tree 包只有官方的 `plugin-governance` 与 `plugin-project-root`。

**如何更新？** `git pull` 本仓库默认分支，然后重跑 `.\install.cmd`（Windows）或 `./scripts/install.sh`（macOS/Linux）。安装脚本会以冻结 lockfile 重装依赖并重新构建。你的 `data/` 目录保持原位。

**为什么上下文调整是源码级集成而不是插件？** 因为它改变核心行为——agent loop、会话处理、token 计量、compaction——它直接应用在核心源码上，而不是挂载为插件。插件只能待在核心旁边；缓存管理必须位于核心拥有的每条路径之内。

**会与已有的官方 DeepSeek Harness 安装冲突吗？** 不会。官方版本数据位于 `~/.dsh`，zDSH-Go 的自包含布局从不写入；卸载脚本仅在显式确认后才会处理它，且从不删除 `~/.agents`。

## 参与贡献

贡献遵循主线的约定——参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md) 与[开发指南](docs/development.zh.md)。面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

- **上游：** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，由 [DeepSeek AI](https://deepseek.com) 开发——官方文档见 [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/)。
- **血缘：** [zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH)——跟踪官方发布、承载自研插件套件（Workbench、Plugin Center、FileHub、AutoPilot、WebStack、Omnivision）的主线。zDSH-Go 由其派生，并将上下文调整集成在本仓 in-tree。

---

## 关于上游：DeepSeek Harness（官方）

zDSH-Go 是下游发行版；原始项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，由 [DeepSeek AI](https://deepseek.com) 开发。官方版本相关信息：

- **官方仓库：** [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- **官方文档：** [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/)
- **通过 npm 运行（官方包）：**

```sh
npx @deepseek-ai/dsh web
```

- **官方社区与支持：** 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈，为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题以便被发现，或加入 [DeepSeek Harness Discord 社区](https://discord.gg/Ycq5dCaS4)。
