# zDSH-Go

[English](README.md) | 中文

[![CI](https://github.com/zsagi1368/zDSH-Go/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/zDSH-Go/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%E2%89%A524-blue.svg)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-11-blue.svg)](package.json) [![Upstream](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--alpha.2-purple.svg)](https://github.com/deepseek-ai/deepseek-harness) [![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#quick-start)

**zDSH-Go 是一个 AI 开发环境**，让你在浏览器里跟 AI 对话、让 AI 帮你写代码、做任务。它是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的增强版，额外集成了上下文缓存管理，让 AI 能更好地记住对话内容。

> **注意：** 这个项目目前处于 _开发者预览_ 阶段，可能会有兼容性变更。运行前请查看 [安全说明](SAFETY.zh.md)。

---

## 快速开始

### 你需要准备什么

| 工具 | 版本要求 | 怎么安装 |
|---|---|---|
| **Node.js** | v22.19 或更高（不支持 v23） | [nodejs.org](https://nodejs.org/) 下载 LTS 版 |
| **pnpm** | v11 或更高 | 安装 Node.js 后运行 `corepack enable pnpm` |
| **Git** | 任意近期版本 | [git-scm.com](https://git-scm.com/) 下载 |

### 安装（只需一次）

**Windows 用户（PowerShell）：**

```powershell
git clone https://github.com/zsagi1368/zDSH-Go.git
cd zDSH-Go
.\install.cmd
```

**macOS / Linux 用户（终端）：**

```bash
git clone https://github.com/zsagi1368/zDSH-Go.git
cd zDSH-Go
./scripts/install.sh
```

安装脚本会自动帮你：检查环境、安装依赖、编译项目、创建数据目录。全程不需要手动操作。

### 运行

每次使用前，先加载环境，然后启动：

**Windows（PowerShell）：**

```powershell
. .\env.ps1
dsh web
```

**macOS / Linux（终端）：**

```bash
source ./env.sh
dsh web
```

运行后会自动打开浏览器，显示 AI 对话界面。默认地址是 `http://127.0.0.1:3080`。

> **提示：** 如果浏览器没有自动打开，手动访问 `http://127.0.0.1:3080` 即可。加 `--no-open` 参数可以不自动打开浏览器。

### 升级

用升级脚本。它会拉取最新版本、核对每个插件所钉的版本确实存在且两处记录一致、重新安装，然后启动一次宿主确认还能正常起来：

**Windows（PowerShell）：**

```powershell
.\upgrade.cmd
```

**macOS / Linux（终端）：**

```bash
./scripts/upgrade.sh
```

加上 `--check`（Windows 上是 `-Check`）可以只做校验、不改动任何东西 —— 适合在真正升级前先看一眼。

如果你想手动来，`git pull` 加安装器是等价的：

**Windows（PowerShell）：**

```powershell
git pull
.\install.cmd
```

**macOS / Linux（终端）：**

```bash
git pull
./scripts/install.sh
```

你的对话记录和数据会保留，不会丢失。访问令牌每次启动都会重新生成，所以要打开宿主打印出来的地址，而不是沿用旧的浏览器标签页。

### 卸载

**Windows（PowerShell）：**

```powershell
.\uninstall.cmd
```

**macOS / Linux（终端）：**

```bash
./scripts/uninstall.sh
```

默认只删除项目文件，保留你的数据。如果想彻底删除所有数据（包括对话记录），加 `--purge` 参数。

---

## 常见问题

**Q: 安装器方式和源码方式有什么区别？**
A: 没有区别。安装器只是自动帮你执行了 `pnpm install` 和 `pnpm run build`，然后生成了 `env.ps1`/`env.sh` 环境文件。两种方式运行的是同一个程序。

**Q: 我已经用了安装器，还能用 pnpm 方式运行吗？**
A: 可以，两者共存。安装器生成的 `env.ps1`/`env.sh` 和 `pnpm dsh web` 不冲突。

**Q: 升级会丢失我的对话记录吗？**
A: 不会。`git pull` 只更新代码，你的数据在 `data/` 目录里，升级时不会动它。

**Q: 卸载会删除我的对话记录吗？**
A: 默认不会。默认只删除项目文件（node_modules、编译产物等）。加 `--purge` 才会删除整个项目目录（包括数据）。

**Q: 我能同时安装官方 DeepSeek Harness 和 zDSH-Go 吗？**
A: 可以。它们的数据目录互不干扰：官方用 `~/.dsh`，zDSH-Go 用项目里的 `data/` 目录。

**Q: 我的数据存在哪里？**
A: 所有数据都在项目目录下的 `data/` 文件夹里，包括对话记录、插件配置、模型设置等。不会写到项目目录之外。

---

## 技术细节（开发者参考）

### 版本信息

| 组成 | 版本 |
|---|---|
| 官方底座（DeepSeek Harness） | `0.2.1-alpha.2` |
| zDSH 主线底座 | `v0.2.1-alpha.2-zDSH20261012a` |
| zDSH-Go 发布版本 | `v0.2.1-alpha.2-zDSH-Go20261012b` |

### 项目血缘

```
DeepSeek Harness（官方）
    ↓
zDSH（官方 + 自研插件套件）
    ↓
zDSH-Go（zDSH + 核心级上下文缓存管理）
```

### 上下文缓存管理

zDSH-Go 在核心源码层面集成了上下文缓存管理，而不是作为插件挂载。这意味着：

- 每个请求路径（agent 循环、会话处理、工具调用、token 计量、模型槽位、压缩）都参与统一的缓存生命周期
- 子 agent 的初始 prompt 带有运行时上下文快照
- 文件读取和搜索结果暴露 `l3.pruning` 元数据
- 有一个常驻的预算门禁脚本 `scripts/verify-budget-table.ts`

### 出厂插件

zDSH-Go 首次启动时会自动安装 8 个出厂插件（6 个默认启用，2 个默认跳过）：

| 插件 | 作用 | 默认启用 |
|---|---|---|
| `dsh-webstack` | 网络搜索工具 | 是 |
| `dsh-webstack-bridge` | 网栈数据桥 | 是 |
| `dsh-omnivision` | 视觉能力 | 是 |
| `dsh-filehub` | 文件管理 | 是 |
| `dsh-plugin-center` | 插件管理中心 | 是 |
| `zdsh-workbench` | IDE 级工作台（文件/编辑器/终端/git/任务） | 是 |
| `dsh-webstack-verticals` | 垂直领域包 | 否（按需启用） |
| `dsh-autopilot` | 自动化任务 | 否（按需启用） |

### 配置说明

安装是自包含的：所有数据都在 `<repo>/data` 目录里，不会写到项目目录之外。

| 变量 | 指向 | 默认值 |
|---|---|---|
| `DSH_HOME` | 数据主目录 | `<repo>/data` |
| `DSH_BRANCH_HOME` | 治理数据（插件注册表、审批账本、已安装插件） | `<repo>/data/zdsh` |
| `DSH_AGENTS_HOME` | 官方技能目录 | `<repo>/data/agents` |

### 安全说明

- **数据隔离** — 自包含布局把所有数据放在 `<repo>/data` 里
- **官方隔离** — 官方版本数据在 `~/.dsh`，zDSH-Go 不会写入
- 运行前请查看 [安全说明](SAFETY.zh.md)

### 升级指南

从旧版本升级时，请查看对应版本的升级说明。升级到当前底座会跨越 `v0.2.0-rc.2` 与 `v0.2.1-alpha.1` 两组官方指南，例如：

- [“自动化任务” bundle 已移除（v0.2.0-rc.2）](docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.zh.md)
- [Web 监听与信任配置迁移到 `webStartup`（v0.2.1-alpha.1）](docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config/guide.zh.md)

### 开发指南

- [开发指南](docs/development.zh.md)
- [架构文档](docs/architecture.zh.md)
- [CONTRIBUTING.md](CONTRIBUTING.zh.md)
- [AGENTS.md](AGENTS.md)

---

## 致谢

- **上游项目：** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by [DeepSeek AI](https://deepseek.com)
- **主线项目：** [zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) — 跟踪官方版本并集成自研插件套件

---

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 关于官方 DeepSeek Harness

zDSH-Go 是下游发行版，原始项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by [DeepSeek AI](https://deepseek.com)。

- **官方仓库：** [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- **官方文档：** [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness)
- **npm 安装（官方包）：** `npx @deepseek-ai/dsh web`
- **官方社区：** [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) · [Discord](https://discord.gg/4MrtZUhpxg)
