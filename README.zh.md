# zDSH-Go

[English](README.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%E2%89%A524-blue.svg)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-11-blue.svg)](package.json) [![Upstream](https://img.shields.io/badge/DeepSeek%20Harness-0.1.3--alpha.1-purple.svg)](https://github.com/deepseek-ai/deepseek-harness) [![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#quick-start)

**zDSH-Go 是 [zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) 的开箱即用发行版**。zDSH 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（[DeepSeek AI](https://deepseek.com) 开发的开源 agent harness 智能体框架）的增强分支；zDSH-Go 在此基础上把全部自研插件出厂预装——克隆、安装、首次启动即得完整插件套件。

## 为什么是 zDSH-Go

zDSH 以两种形态发布，源自同一份源码树。主树（[zsagi1368/deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) 的 `zdsh-latest` 分支）保持纯粹形态：轻量的 harness，自研插件按需显式添加。zDSH-Go 则是整合形态——它与主树的**唯一**区别是所有自研功能面全部出厂预装：全新安装即可运行完整套件，零手工 `dsh plugin add`，零 profile 手工编辑。

| | 主树（`zdsh-latest`） | zDSH-Go（本仓库） |
|---|---|---|
| 源码 | DeepSeek Harness 的 zDSH 分支 | 同一份源码树 |
| 自研插件 | 按需显式添加 | 全部出厂预装 |
| 首次启动 | 核心 harness + Web UI | 完整插件套件即刻可用 |
| 治理数据兜底目录 | `~/.dsh-zdsh` | `~/.dsh-zdsh-go`（与主树互不冲突） |

> 上游 harness 处于_开发者预览_阶段，迭代很快——未来会出现破坏兼容性的变更。运行前请阅读[安全说明](SAFETY.zh.md)。

## 出厂预装的插件与功能

| 组件 | 它带来什么 | 发布形态 | 源码 |
|---|---|---|---|
| **Workbench** | Web UI 的 IDE 级停靠工作区：文件、编辑器、终端、git、任务与浏览面板收拢于一个注册表服务 | 内树客户端包，出厂挂载 | [zdsh-workbench](https://github.com/zsagi1368/zdsh-workbench) |
| **FileHub** | 统一文件中心：随处上传、`@` 引用万物、让模型读懂文档、为图片生成讲解 | 出厂预装插件 | [zdsh-filehub](https://github.com/zsagi1368/zdsh-filehub) |
| **Plugin Center** | 内置插件中心：在同一设置页发现、评估、安装、更新与审计插件 | 出厂预装插件 | [zdsh-plugin-center](https://github.com/zsagi1368/zdsh-plugin-center) |
| **Plugin Registry 目录** | 第一方插件目录，作为 Plugin Center 的内置 seed 出厂，离线即可发现插件；远端目录仍是在线通道 | 随 Plugin Center 内置的离线 seed | 内树 seed 数据 |
| **AutoPilot** | 自动化引擎：Continue（中断自动续跑）、Guard（沙箱优先权限策略）、Review（只读第二模型审查者） | 出厂预装插件 | [zdsh-autopilot](https://github.com/zsagi1368/zdsh-autopilot) |
| **WebStack** | 一体化网络搜索与抓取内核，默认加固；以共存模式注册在内置提供方之侧 | 出厂预装插件（三个源码包） | [dsh-webstack](https://github.com/zsagi1368/dsh-webstack) |
| **Omnivision** | 视觉桥：每张图片在到达模型前先转为忠实的文字描述，保持前缀缓存常热 | 出厂预装插件 | [dsh-omnivision](https://github.com/zsagi1368/dsh-omnivision) |
| **ContextManagement** | 覆盖 agent 循环、会话处理、token 计量与压缩的上下文缓存管理 | 核心源码级整合 | 内树（直连分支源码） |
| **dsh-guard** | 安装守护：检查 web profile 的已知插件生态破坏模式，只报告、不阻断安装 | 安装脚本运行的单文件守护 | 内树（`packages/plugins/dsh-guard`） |

<details>
<summary><strong>插件详解——每个出厂组件到底做什么</strong></summary>

- **Workbench** — 一个注册表服务（`ctx.workbench`）承载文件工作区、终端、git 中心、任务中心与浏览面板，供其他插件扩展。注册经过兼容性守卫把关：宿主不匹配时工作台跳过注册而不是抛错，宿主照常启动。
- **FileHub** — 四条上传通道（按钮、全页拖放、粘贴、保留目录层级的整文件夹）汇入同一条队列；`@` 文件引用在发送时做存在性校验，展开为结构化引用注入消息；`read_document` 支持分页读取文本、PDF、DOCX 与 XLSX 并按格式限额；图片讲解默认走本地 Ollama 瀑布——你不点头，一个字节都不出机器；另有汇聚全部会话文件的文件控制台。
- **Plugin Center** — 有界的目录浏览，每张卡片带信任、兼容性与钉定来源徽章；安装钉定到精确的 GitHub commit 或 npm 语义化版本；每次安装/更新/卸载都是一次性计划，凭确认码执行，profile 文件先哈希备份，任何失败按字节回滚；审计日志只追加且经密钥脱敏。
- **Plugin Registry 目录** — 第一方插件目录（catalog + SHA-256 校验件）作为本地 seed 内置于 Plugin Center，配三级降级（在线目录 → 摘要校验缓存 → 内置快照），完全没有网络也能发现插件。
- **AutoPilot** — 一个内核，四条跨模块不变量：有待审批时自动续跑延期；审查熔断打开时抑制自动续跑；全局暂停停掉所有模块；每个审批只被处置一次。全部功能收拢在 `/ap` 一条命令面上，配 `conservative` / `standard` / `fullspeed` 三档预设。
- **WebStack** — 注册进宿主 `ctx.web` 接缝的单一中立聚合器：跨 `native` / `free` / `api` / `selfhosted` / `mcp` 五层路由，免钥免费池零配置可用，RRF 融合带时间衰减，两级缓存，四道 SSRF 关卡。以共存模式出厂：切换搜索层只是改运行时配置，从不需要重新打补丁。
- **Omnivision** — 图片根本不进模型请求：前置桥先通过提供方链（LM Studio → Ollama → 免费/带钥云服务）把图转成文字，请求形状保持逐字节一致，前缀缓存不被打穿。失败不在模型上下文留任何痕迹，只通过结构化通道上报 UI。一个 API key 都不配，匿名免费端点照样提供视觉能力。
- **ContextManagement** — 核心源码级整合：十二个补丁直连分支源码，覆盖 agent 循环、会话处理、工具、token 计量、模型槽位、压缩与子代理，让上下文缓存管理成为核心本体的一部分，而非外挂插件。
- **dsh-guard** — 安装期间对 web profile 跑只读 `check`，扫描已知的插件生态破坏模式。只报告、不阻断（全新安装还没有 profile，此时报警属正常）；检查钉定在本安装的数据面，绝不窥探主树。

</details>

<a id="quick-start"></a>

## 快速开始

### 前置要求

| | |
|---|---|
| Node.js | `^22.19.0 || >=24`（不支持 23.x） |
| pnpm | ≥ 11 — 用 `corepack enable pnpm` 启用（或 `npm install -g pnpm`） |
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

安装脚本会检查前置要求，依次执行 `pnpm install --frozen-lockfile` 与 `pnpm run build`，对 web profile 做一次只读（不阻断）的 `dsh-guard` 检查，并生成：

- `data/` — 自包含的数据主目录（`DSH_HOME`）。官方模块数据与 zDSH-Go 治理数据（插件注册表、审批账本，以及 `data/zdsh/` 下的已装插件）都保存在这里。
- `env.ps1` / `env.sh` — 环境加载脚本，定义 `DSH_HOME`、`DSH_BRANCH_HOME`、`DSH_AGENTS_HOME`，以及指向已构建 CLI 的 `dsh` 命令。

<a id="run"></a>

### 运行

加载环境，然后启动 Web UI：

```sh
# PowerShell
. .\env.ps1
# bash
source ./env.sh

dsh web
```

`dsh web` 默认在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL——本地转发地址由 SSH 客户端或编辑器持有。传 `--no-open` 可仅运行服务器、不打开浏览器。

<a id="run-from-source"></a>

也可以不经安装脚本，直接从检出版运行：

```sh
pnpm install
pnpm run build
pnpm dsh web
```

## 配置

安装是**自包含**的：所有数据都在 `<repo>/data` 内，默认不向仓库目录之外的任何位置写入。

| 变量 | 指向 | 默认值 |
|---|---|---|
| `DSH_HOME` | 数据主目录：官方模块数据 | `<repo>/data` |
| `DSH_BRANCH_HOME` | zDSH-Go 治理数据：插件注册表、审批账本、已装插件 | `<repo>/data/zdsh` |
| `DSH_AGENTS_HOME` | 官方技能目录 | `<repo>/data/agents` |

**自定义数据目录** — 在生成的 `env.ps1` / `env.sh` 中修改 `DSH_HOME`（按需连同 `DSH_BRANCH_HOME` / `DSH_AGENTS_HOME`）后重新加载即可。重跑安装脚本会按仓库当前位置重新生成这两个文件，迁移仓库位置后需重新指回自定义目录。

治理数据根目录按此顺序解析：显式 `DSH_BRANCH_HOME` → `<DSH_HOME>/zdsh` → 兜底目录 `~/.dsh-zdsh-go`。只有两个变量都未设置时才落到兜底目录，因此自包含安装从不触碰它。兜底名与主树的 `~/.dsh-zdsh` 刻意不同——这就是两套发行版能在同一台机器上共存的原因。

## 更新与卸载

**更新：** 拉取最新的 `zDSH-go` 分支，重跑对应平台的安装脚本——脚本会以冻结锁文件重装依赖并重新构建。

**卸载：** 在仓库检出目录中运行对应平台的卸载脚本：

```sh
# Windows (PowerShell 5.1+)
.\uninstall.cmd
# macOS / Linux / WSL / Git Bash
./scripts/uninstall.sh
```

| 模式 | 行为 |
|---|---|
| 默认 | 移除检出版内所有被 gitignore 忽略的产物（`node_modules`、构建输出、`data/`、`env.ps1` / `env.sh`），恢复纯净检出版状态。可能被清理的用户本地文件（`.env`、`.claude/` 等）会先备份到临时目录（内附 `RESTORE.txt`）。它从不触碰仓库目录之外的任何东西。 |
| `--purge`（PowerShell：`-Purge`） | 在清理之后连整个仓库目录一并删除。 |
| `--clean-legacy`（PowerShell：`-CleanLegacy`） | 同时删除 zDSH-Go 主目录（`~/.dsh-zdsh-go`）与旧版插件主目录（`~/.zdsh-workbench`、`~/.zdsh-plugin-center`）。主树数据目录 `~/.dsh-zdsh` **不会**被触碰。 |

`~/.dsh` 属于官方版本数据，可能存有与其共享的内容——仅在显式交互确认（或传 `--yes` / PowerShell `-Yes`）后才会删除。脚本从不删除 `~/.agents`，只在存在时报告。每次运行都会打印用户主目录的残留扫描结果。

## 安全

- **dsh-guard 检查** — 安装脚本对 web profile 跑一次只读、不阻断的完整性检查。它报告已知的破坏模式后继续安装（全新安装还没有 profile，此时报警属正常）。检查钉定在本安装的数据面，绝不窥探 `~/.dsh` 或任何其他安装。
- **数据本地化** — 自包含布局把官方模块数据、治理数据与已装插件全部收在 `<repo>/data` 下。除非 `DSH_HOME` 未设置而落到专用的 `~/.dsh-zdsh-go` 兜底，否则不向仓库目录之外写入任何东西。
- **出厂插件的安全加固** — 整套套件继承各组件既有的安全模型：WebStack 的四道 SSRF 关卡、FileHub 的路径沙箱与仅限回环的本地探测、Plugin Center 的钉定安装与逐字节回滚、AutoPilot 对所有跨模型边界内容做结构化脱敏、Omnivision 的 SSRF 守卫与三层凭据脱敏。
- 运行前请阅读[安全说明](SAFETY.zh.md)。

## 常见问题

**zDSH-Go 与 zDSH 主树是什么关系？** 同一份源码树，整合深度不同。主树（[zsagi1368/deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) 的 `zdsh-latest` 分支）是纯粹形态的开发主线；zDSH-Go 是同一份代码加全部自研插件出厂预装。两者安装彼此独立、可以共存：zDSH-Go 的兜底目录是 `~/.dsh-zdsh-go`，主树是 `~/.dsh-zdsh`，双方的卸载脚本都不碰对方的数据。

**可以只装一部分预装插件吗？** zDSH-Go 没有「自选子集」安装器——整套预装就是它的出厂设计。这些插件本身都是普通插件，可在 Web UI 中管理。如果想要自己挑组合，请改用主树，通过 Plugin Center 或 `dsh plugin add` 精确添加需要的功能。

**如何升级？** 对 `zDSH-go` 分支执行 `git pull`，然后重跑 `.\install.cmd`（Windows）或 `./scripts/install.sh`（macOS/Linux）。脚本以冻结锁文件重装依赖并重新构建。你的 `data/` 目录原样保留。

**ContextManagement 为什么是源码级整合而不是插件？** 因为它改变的是核心行为——agent 循环、会话处理、token 计量、压缩——所以以十二个核心补丁直连分支源码落地，而不是以插件挂载。同一功能的插件形态作为替代轨道存在；两者绝不同时挂载，不存在双重注册。

**会与已有的官方 DeepSeek Harness 安装冲突吗？** 不会。官方版本数据在 `~/.dsh`，zDSH-Go 的自包含布局从不写入它；卸载脚本只在显式确认后才碰它，且从不删除 `~/.agents`。

## 参与贡献

贡献请遵循主树的规范——参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md) 与[开发指南](docs/development.zh.md)。面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

- **上游：** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，由 [DeepSeek AI](https://deepseek.com) 开发——官方文档见 [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/)。
- **本发行版内置的自研组件：** [zdsh-workbench](https://github.com/zsagi1368/zdsh-workbench)、[zdsh-plugin-center](https://github.com/zsagi1368/zdsh-plugin-center)、[zdsh-filehub](https://github.com/zsagi1368/zdsh-filehub)、[zdsh-autopilot](https://github.com/zsagi1368/zdsh-autopilot)、[dsh-webstack](https://github.com/zsagi1368/dsh-webstack)、[dsh-omnivision](https://github.com/zsagi1368/dsh-omnivision)，以及内树整合的 ContextManagement 与 dsh-guard。
