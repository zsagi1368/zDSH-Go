# zDSH

[English](README.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

zDSH 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness 智能体框架）的增强分支。它跟踪官方上游版本，同时加入版本自适应的增强功能——当这些功能与核心环境冲突时会自动停用，不影响主环境。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

本仓库（`zsagi1368/deepseek-harness-zDSH`）即 zDSH 分支。活跃开发分支为 `zdsh-latest`，与官方最新发布保持同步。

## 开发者预览

zDSH 跟踪的 harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

## zDSH-go 分支

活跃开发分支 `zdsh-latest` 是主树：保持纯 zDSH 形态，自研插件按需显式添加。`zDSH-go` 分支是同一源码树的开箱即用整合分支——它与主树的唯一区别是全部自研 zDSH 插件出厂预装，全新安装即可运行完整插件套件。安装方式与下文相同：克隆本仓库，检出 `zDSH-go`，再运行对应平台的安装脚本。

| 组件 | 它带来什么 | 挂载形态 |
|---|---|---|
| Workbench | Web UI 的 IDE 级停靠工作区：文件、编辑器、终端、git、任务与浏览面板收拢于一个注册表服务 | 内树客户端包，出厂挂载 |
| FileHub | 统一文件中心：随处上传、`@` 引用万物、让模型读懂文档、为图片生成讲解 | 出厂预装插件 |
| Plugin Center | 内置插件中心：在同一设置页发现、评估、安装、更新与审计插件 | 出厂预装插件 |
| AutoPilot | 自动化引擎：Continue（中断自动续跑）、Guard（沙箱优先权限策略）、Review（只读第二模型审查者） | 出厂预装插件 |
| WebStack | 一体化网络搜索与抓取内核，默认加固；以共存模式注册在内置提供方之侧 | 出厂预装插件（三个源码包） |
| Omnivision | 视觉桥：每张图片在到达模型前先转为忠实的文字描述，保持前缀缓存常热 | 出厂预装插件 |
| ContextManagement | 上下文缓存管理（核心源码级整合） | 核心补丁，直连分支源码 |
| dsh-guard | 安装守护：检查 web profile 的已知插件生态破坏模式，只报告、不阻断安装 | 安装脚本运行的单文件守护 |
| Plugin Registry 目录 | 第一方插件目录，作为 Plugin Center 的内置 seed 出厂，离线即可发现插件；远端目录仍是在线通道 | 随 Plugin Center 内置的离线 seed |

安装与卸载独立于主树，机制相同：所有数据都收拢在仓库目录的 `data/` 内，生成的 `env.ps1` / `env.sh` 一并定义 `DSH_HOME` 与 `DSH_BRANCH_HOME`。zDSH-go 的兜底主目录为 `~/.dsh-zdsh-go`，与主树数据目录 `~/.dsh-zdsh` 互不干扰；`--clean-legacy` 永不触碰主树数据。

要更换数据目录，把生成的环境加载脚本中的 `DSH_HOME` 指向另一目录即可——与主树同一机制。

## 安装

zDSH 以源码形式分发。克隆本仓库并运行对应平台的安装脚本——所有数据都收拢在仓库目录内：

```sh
git clone https://github.com/zsagi1368/deepseek-harness-zDSH.git
cd deepseek-harness-zDSH
git checkout zdsh-latest

# Windows (PowerShell 5.1+)
.\install.cmd
# macOS / Linux / WSL / Git Bash
./scripts/install.sh
```

安装脚本会检查前置条件（`Node.js ^22.19.0 || >=24` 与 `pnpm`），依次执行 `pnpm install --frozen-lockfile` 与 `pnpm run build`，并生成：

- `data/` —— 数据主目录（`DSH_HOME`）。官方模块数据与 zDSH 治理数据（插件注册表、审批账本，以及 `data/zdsh/` 下的已装插件）都保存在这里。
- `env.ps1` / `env.sh` —— 环境加载脚本，定义 `DSH_HOME`、`DSH_BRANCH_HOME`、`DSH_AGENTS_HOME`，以及指向已构建 CLI 的 `dsh` 命令。

<a id="run"></a>

## 运行

加载环境后，启动 Web UI：

```sh
# PowerShell
. .\env.ps1
# bash
source ./env.sh

dsh web
```

`dsh web` 默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。

也可以不经安装脚本，直接从检出版运行：

<a id="run-from-source"></a>

```sh
pnpm install
pnpm run build
pnpm dsh web
```

## 卸载

在仓库检出目录中运行对应平台的卸载脚本：

```sh
# Windows (PowerShell 5.1+)
.\uninstall.cmd
# macOS / Linux / WSL / Git Bash
./scripts/uninstall.sh
```

默认模式会移除检出版内所有被 gitignore 忽略的产物（`node_modules`、构建输出、`data/`、`env.ps1` / `env.sh`），恢复纯净检出版状态——它从不触碰仓库目录之外的任何东西。附加选项：`--purge`（PowerShell 为 `-Purge`）会在清理之后连整个仓库目录一并删除；`--clean-legacy`（PowerShell 为 `-CleanLegacy`）会同时删除 zDSH-go 主目录（`~/.dsh-zdsh-go`）与旧版插件主目录（`~/.zdsh-workbench`、`~/.zdsh-plugin-center`）；主树 zDSH 数据目录 `~/.dsh-zdsh` 不会被触碰。`~/.dsh` 属于官方版本数据，仅在显式确认后才会处理；本脚本从不删除 `~/.agents`，仅在存在时报告。

## zDSH 增强功能

zDSH 在官方 harness 之上加入版本自适应特性；每个特性都会探测已安装的核心，环境不匹配时干净地自我停用，因此上游漂移绝不会破坏基础产品。亮点包括模型槽位路由系统、带宿主钳制沙箱的项目级插件根、插件治理，以及自包含的安装布局。详见 [zDSH 子系统指南](docs/subsystems/zdsh.zh.md)。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。面向 agent：请遵循 [AGENTS.md](AGENTS.md)。请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 关于上游：DeepSeek Harness（官方）

zDSH 是一个分支；原始项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，由 [DeepSeek AI](https://deepseek.com) 开发。官方版本相关信息：

- **官方仓库：** [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- **官方文档：** [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/)
- **通过 npm 运行（官方包）：**

```sh
npx @deepseek-ai/dsh web
```

- **官方社区与支持：** 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈，为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题以便被发现，或加入 [DeepSeek Harness Discord 社区](https://discord.gg/Ycq5dCaS4)。
