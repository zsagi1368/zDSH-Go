# zDSH-Go

[English](README.md) | 中文

[![CI](https://github.com/zsagi1368/zDSH-Go/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/zDSH-Go/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%E2%89%A524-blue.svg)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-11-blue.svg)](package.json) [![Upstream](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--alpha.2-purple.svg)](https://github.com/deepseek-ai/deepseek-harness) [![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#quick-start)

**zDSH-Go 是 [zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) 加上一项重大的上下文处理调整。** zDSH 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness 智能体框架）的增强分支。在 zDSH-Go 中，上下文缓存管理以核心源码级集成的方式落地，因此它不能以插件形态交付；zDSH 的其余部分保持原样。自研插件经 zDSH 主线及其出厂 seed 进入 zDSH-Go：首次启动时，治理预装钩子会把钉定的插件谱装入本仓库自己的数据主目录（见[出厂插件谱](#factory-plugin-roster)）。

## 版本

| 组成 | 版本 |
| --- | --- |
| 官方底座（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)） | `0.2.1-alpha.2` |
| zDSH 主线底座（本仓库的上游） | `v0.2.1-alpha.2-zDSH20261011d` |
| zDSH-Go 发布版本 | `v0.2.1-alpha.2-zDSH-Go20261012a` |

zDSH-Go 跟踪上表所列的 zDSH 主线版本，随主线滚动同步。zDSH-Go 版本规则：`<官方版本>-zDSH-Go<日期><修订字母>`，日期为 zDSH-Go 战役收官日，字母为当日修订序号。根 `package.json` 保持官方底座版本零触碰；zDSH-Go 版本以配套发布 tag 为准。

## zDSH 血缘链

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（官方）→ **zDSH**（[zsagi1368/deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH)：官方最新 + 自研插件套件 + 出厂 seed = 开箱即用版）→ **zDSH-Go**（本仓库：zDSH + 核心级上下文调整 = 上下文调整版）。

- zDSH-Go 的上游永远是 zDSH，绝不绕过 zDSH 直接同步官方仓库。
- 自研插件住在 zDSH 主线。zDSH-Go 随附官方 harness 库，以及主线自有、位于 `packages/zdsh/` 的包（governance、project root、compat、factory bundle、governance UI），插件谱经治理通道安装（`pluginGovernance.install` 解析钉定的 npm 来源）。

| | 官方 DeepSeek Harness | zDSH（主线） | zDSH-Go（本仓库） |
|---|---|---|---|
| 定位 | DeepSeek AI 的上游 harness | 官方最新 + 自研插件套件 | zDSH + 核心级上下文调整 |
| 上下文处理 | 上游行为 | 上游行为 | 核心源码级集成（非插件） |
| 自研插件 | —— | 全套插件，经治理通道安装 | 同一套出厂谱，经治理通道装入本仓库数据主目录 |
| 治理数据兜底目录 | `~/.dsh` | `~/.dsh-zdsh` | `~/.dsh-zdsh-go`（与前两者互不冲突） |

> 上游 harness 处于 _开发者预览_ 阶段，正在快速迭代——未来将出现破坏兼容性的变更。运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

## 上下文调整改变了什么

调整直接落在核心源码上——agent loop、会话处理与投影、tools、token 计量、模型槽位、compaction、subagents——上下文缓存管理因此是核心行为的一部分，而不是外挂插件。具体表现：

- **核心级上下文缓存管理。** 核心拥有的每条请求路径都参与其中：agent loop、会话处理、tools、token 计量、模型槽位与 compaction 共享同一条缓存感知的上下文生命周期，而不是靠附加组件事后改造。
- **子代理 prompt 携带运行时上下文快照。** 每个子代理的初始 prompt 前置一个运行时上下文快照块，派生的 worker 与父级从同一份上下文事实出发。
- **fork 与团队成员不再预置 seed。** 团队与 fork 成员会话不再预置会话头——seed 留在它该在的地方，即父级。
- **上下文裁剪可观测。** 文件读取与搜索工具的结果暴露 `l3.pruning { bytes, prunable }` 元数据：裁剪字节数与可裁剪余量直接出现在工具输出里。
- **常驻预算门。** `scripts/verify-budget-table.ts` 已注册为验证门——开发者和 CI 在每次变更上校验 token 预算表的真实性。

## 升级须知

升级须知按目标底座分组——请阅读与你要升级到的版本对应的小节。每个底座变更条目均链接 `docs/upgrade-guide/` 下的官方迁移指南。

### 升级到 0.2.1-alpha.2 底座

从 `v0.2.0-rc.2-zDSH*` 版本升级会把官方底座从 `0.2.0-rc.2` 迁移到 `0.2.1-alpha.2`，跨越官方 `v0.2.0-rc.2` 与 `v0.2.1-alpha.1` 两组指南。以下汇总用户数据面与用户可见的变更。

- **运行时不变式插件架构被移除。** 官方底座不再发布 `@deepseek-ai/dsh-invariants`、`InvariantRegistry`、`InvariantInstaller`、`InvariantFailure`、`InvariantError`，也不再发布任何 `<package>/invariant` 子路径，`sdk-minimal` 的五条不变式行已不复存在。引用已移除模块的 `cordis.yml`、profile patch 或 `--patch` overlay 无法加载该模块，指向上述五个 id 之一的 patch 会记录 `patch: entry <id> not found`，导入该包或其子路径的 TypeScript 代码无法编译——请删除这些行、patch 条目与 import。来源：[`remove-runtime-invariants`](docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.zh.md)。
- **subagent 委派改为受管理的 activation 模型。** `run_in_background`、`backgroundMode` 与 `enableRunInBackground` 被移除；每次委派返回 `{ kind: 'activation', subagentId }`，最终答案以父级完成通知送达。前台结果与 `{ kind: 'background', jobId }` 返回已不复存在，`job_output` / `job_kill` 不再收集结果或停止 subagent——停止当前执行请用 `interrupt_agent`，`send_message` 仅适用于本地 subagent。来源：[`subagent-activations`](docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.zh.md)。
- **Agent Teams 消息直接发往目标收件箱。** 待投递消息上限（`maxPendingMessagesPerMember`）被移除，`send_message` 仅返回 `{ "sent": true }`——不再有消息 ID，也没有 accepted 或 queued 状态。升级前排队而未被投递的 Team 消息此后永不派发，如仍需要请显式重发（先查看目标历史以免重复）。名单与任务状态仍然持久。来源：[`team-direct-inbox`](docs/upgrade-guide/v0.2.1-alpha.1/team-direct-inbox/guide.zh.md)。
- **Session 工作目录取代内置 cwd 配置。** loop 的内置 `{{cwd}}` 提示词变量与 `dsh-subagent-acp` / `dsh-subagent-dsh-sdk` 的 `cwd` 配置键被移除；提示词模板保留未解析的 `{{cwd}}` 会在模型请求发出前失败。改变执行目录请用 `working_directory` 工具，为 subagent 指定目录请在其启动请求中传入 `cwd`；`Session.header.cwd` 仍是原始项目标识，而非当前目录。来源：[`working-directory`](docs/upgrade-guide/v0.2.1-alpha.1/working-directory/guide.zh.md)。
- **Claude Code 与 Codex bundle 新增全局委派工具。** 选中 `dsh-subagent-claude-code` 或 `dsh-subagent-codex` 现在还会把 `tool-subagent-claude-code` / `tool-subagent-codex` 注册为宿主全局工具，包括 `minimal` 在内的所有 preset 均可见。既有仅安装提供方的安装需在插件 → 官方中**更新**才能获得带工具的 bundle，并请移除过时的 `backgroundMode` 设置。来源：[`native-subagent-bundle-tools`](docs/upgrade-guide/v0.2.1-alpha.1/native-subagent-bundle-tools/guide.zh.md)。
- **Web 监听地址被限定为本机具体地址。** `dsh web` 在加载时拒绝通配监听 host（`0.0.0.0`、`::`），因为绑定所有接口会把端口暴露到网络——请改用本机网卡的一个具体 IPv4/IPv6 地址（默认 `127.0.0.1` 不受影响）。调用信任从 `webRuntime` 服务迁移到 `webStartup`：`inject: [webRuntime]` 或读取 `ctx.webRuntime.trustedHosts` 的 overlay 必须迁移，`--trusted-host` authority 改从 `ctx.webStartup.trustedHosts` 读取。来源：[`web-listener-trust-config`](docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config/guide.zh.md)。
- **工具展示只接受 `native` 或 `ptc`。** `both` 模式被拒绝，`DSH_TOOLS_MODE=both` 亦然；直接函数调用用 `mode: native`，`run_code` 程序用 `mode: ptc`，并更新 `ctx.tools.presentAs('both')` 的调用方。同一应用内不同 preset 仍可各用不同的模式。来源：[`tool-presentation-mode`](docs/upgrade-guide/v0.2.1-alpha.1/tool-presentation-mode/guide.zh.md)。
- **“自动化任务”bundle 退役，Schedule 并入 Web 组合。** 已存任务与投递记录留在磁盘并继续使用；`@deepseek-ai/dsh-web-app` 在每个 Web profile 中挂载 `schedule` / `ui-schedule`，加载 profile 会自动改写其 `package.json`、移除 `@deepseek-ai/dsh-experimental-schedule-bundle`（每个受影响的 profile 启动一次 `dsh` 即可）。顶层 `time-context` override 不再匹配任何行——请删除。来源：[`schedule-bundle-retired`](docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.zh.md)。
- **DeepSeek API-key 模型在配置凭证前隐藏。** `deepseek-official` 路由在缺少凭证时返回空目录，Desktop 与 Web 会隐藏 DeepSeek 分组；请在设置 → 模型中配置密钥，或在启动环境中提供 `apiKeyEnv` 指定的引用（默认 `DEEPSEEK_API_KEY`）。账号登录路由不变。来源：[`deepseek-model-discovery`](docs/upgrade-guide/v0.2.1-alpha.1/deepseek-model-discovery/guide.zh.md)。
- **New Session 创建全新 Agent。** Web 与 Desktop 的 New Session 不再复用既有空 Session（可能残留旧 preset 定义）；工作区重连（`openWorkspace` / `connectWorkspace`）仍会复用合格空会话。已有 Agent 保留其 preset 组合。来源：[`new-session-generations`](docs/upgrade-guide/v0.2.1-alpha.1/new-session-generations/guide.zh.md)。
- **自定义 SSH 组合迁移到显式 launch 模式。** `dsh-ssh` 用 `launch` 取代顶层 `node`、`bootstrapPath` 与 `bootstrapHash`，并要求 SSH 协议 2；请同步更新已安装的 helper、其 hash 与配置。来源：[`ssh-helper-launch`](docs/upgrade-guide/v0.2.1-alpha.1/ssh-helper-launch/guide.zh.md)。
- **Python PTC 运行纳入共享沙箱，可选运行时资源需显式下载。** Python PTC 对每个程序应用共享 `sandbox` / `sandboxPolicy`（无法建立隔离时受限运行以 `sandbox-unavailable` 失败）；Python 运行时 wheel 不再内置 Office sidecar 与创作环境，使用前请调用 `deepseek_harness_runtime.download_office()` / `download_primary_runtime()`；内置 NumPy 与 pandas 不再携带上游测试套件——相关导入请改用独立环境。来源：[`python-ptc-sandbox`](docs/upgrade-guide/v0.2.1-alpha.1/python-ptc-sandbox/guide.zh.md)、[`python-optional-resources`](docs/upgrade-guide/v0.2.1-alpha.1/python-optional-resources/guide.zh.md)、[`bundled-python-tests`](docs/upgrade-guide/v0.2.0-rc.2/bundled-python-tests/guide.zh.md)。
- **可选能力包需显式安装。** hook 桥、webhook 包、Ralph 行与 skill badge 不再默认安装或组合：请连同必需 peer 一并加入 profile（例如 `dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code @deepseek-ai/dsh-hook-protocol`），并在覆盖某 bundle 的行之前先选中该 bundle。来源：[`experimental-package-composition`](docs/upgrade-guide/v0.2.1-alpha.1/experimental-package-composition/guide.zh.md)。
- **更小的配置与 CLI 变更。** `agent-instructions` 不再接受 `dshHome`——请改用 `DSH_HOME`；`dsh plugin` 只在转发的 pnpm 参数之前读取 `--profile`（`dsh plugin --profile web add <package>`）；账号登录传输失败现在报 `no-response` 而非 `network`；Desktop 测试构建的更新策略认证弹窗默认关闭，除非在 `desktop/settings.json` 设置 `updates.allowTestAuthPopupWindow`。来源：[`instruction-home-override`](docs/upgrade-guide/v0.2.1-alpha.1/instruction-home-override/guide.zh.md)、[`plugin-option-placement`](docs/upgrade-guide/v0.2.1-alpha.1/plugin-option-placement/guide.zh.md)、[`account-sign-in-errors`](docs/upgrade-guide/v0.2.0-rc.2/account-sign-in-errors/guide.zh.md)、[`desktop-test-auth-popup`](docs/upgrade-guide/v0.2.1-alpha.1/desktop-test-auth-popup/guide.zh.md)。
- **zDSH 只保留不变式类型链，不挂载运行时注册表。** `dsh-invariants` 包与四个自研 `./invariant` 配套件（`dsh-model-slots`、`dsh-plugin-governance`、`dsh-plugin-project-root`、`dsh-compat`）留在树内并保持可编译；没有任何出厂组合挂载 `ctx.invariants`，运行时诊断保持未接线——按官方废弃架构的现状接受。来源：[`packages/runtime-diagnostics/invariants/README.zh.md`](packages/runtime-diagnostics/invariants/README.zh.md)。
- **zDSH 的会话标题槽位路由保持工作。** `title` 模型槽位（`ctx.modelSlots`）仍路由辅助标题调用；`dsh-session-title-llm` 已随本次同步迁移到官方 `executeSessionTitleLlm` 提供方 API，包测试通过（21 例）。基于 `registerSessionTitleLlmProvider` 的自定义标题提供方须改为直接 `ctx.sessionTitle.register()` 加 `executeSessionTitleLlm`。来源：[`dsh-model-slots`](packages/llm/model-slots/README.zh.md)、[`dsh-session-title-llm`](packages/session/session-title-llm/README.zh.md)、[`session-title-provider-strategy`](docs/upgrade-guide/v0.2.1-alpha.1/session-title-provider-strategy/guide.zh.md)。
- **zDSH 的 model-slot 用户层槽位覆写在本底座上保持禁用。** 官方 0.1.7 的 settings 重构退役了其依赖的注册面，因此用户层槽位覆写按 fail-soft 方式禁用（服务核心不受影响）。该项继承自 zDSH 主线；本发布不承诺修复。
- **出厂插件 pin 已轮转到 alpha.2 底座。** [`zdsh-factory/seed.json`](zdsh-factory/seed.json) 与 [`packages/zdsh/factory-bundle/package.json`](packages/zdsh/factory-bundle/package.json) 已携带 alpha.2 适配锚（webstack 族、filehub、workbench、autopilot 重新钉锚；omnivision 与 plugin-center 未变）。八件谱及其 6 mounted / 2 skipped 姿态不变。

- **zDSH-Go：插件改由出厂 seed 交付，in-tree Workbench 客户端退役。** 本线继承主线的出厂预装（见[出厂插件谱](#factory-plugin-roster)）：八件谱会在首次启动时装入本仓库自己的数据主目录。随之内树 `packages/client/workbench` 副本一并移除——Workbench 现为安装态 `core/workbench` 插件（`zdsh-workbench`），此前会构建内树副本的检出版改由预装钩子装入插件谱即可。上下文调整本身无需迁移：它位于核心源码、不在插件数据里，且既有 zDSH-Go 数据主目录（`data/`，或 `~/.dsh-zdsh-go` 兜底目录）布局不变。

### 升级到 0.1.7-rc.2 底座

从 `v0.1.5-rc.2-zDSH*` 版本升级会把官方底座从 `0.1.5-rc.2` 迁移到 `0.1.7-rc.2`。升级前请阅读本小节——覆盖用户数据面。

- **会话持久化数据不跨版本迁移。** 0.1.5 与 0.1.7 的持久化面互不兼容（社区实证 [#7921](https://github.com/deepseek-ai/deepseek-harness/discussions/7921) 与 [#7983](https://github.com/deepseek-ai/deepseek-harness/discussions/7983)）。升级方向（#7921）：0.1.7-rc.1 → rc.2 升级在 Windows 上触发数据目录重初始化，会话/历史/插件状态丢失——升级前完整备份 `data/` 目录，且不要让 0.1.5 与 0.1.7 两套安装共用同一数据主目录。回退方向（#7983）：0.1.7 删除了共用浏览器持久化键 `dsh.workspace.view.v5` 下的 `sessionUpdatedAtByAccount` 字段（键本身未升版——两版共用同一键），回退到 0.1.5-rc.2 后会话列表渲染为空；会话数据本身不丢——清除该 localStorage 键后刷新即可恢复（分组/排序偏好会重置）。该字段级 schema 变更无官方迁移/兼容处理。官方 0.1.7 引入 Session 日志 V4 并提供一次性批量迁移命令 `pnpm run migrate:sessions-to-v4`（默认操作 `~/.dsh/sessions`；zDSH 的数据主目录在仓库内 `data/`，须显式传 `--sessions-dir`）。
- **model-slots 用户层槽位覆写 fail-soft 降级。** 官方 0.1.7 settings 重写移除了 `SettingsProvider` 命名空间注册面，`dsh-model-slots` compat 守卫据此仅跳过 settings 段注册，roster 审计中该件报告为禁用。这是 dsh-compat 框架的设计兑现——官方 API 变动时功能自动降级、不拖垮核心：`ModelSlotRegistry` 服务本体仍工作在 raw config（resolve/dispatch/audit 全活）。该债务以 DEBT-MODEL-SLOTS 登记，出现真实生产消费需求时按预案恢复。
- **治理台 UI 首次可达。** zDSH 治理台 tab 此前在本分支上是孤儿包（挂载行在历史移植中丢失，浏览器半侧不可达）。现已迁至 `packages/zdsh/plugin-governance-ui`（包名改为 `@deepseek-ai/dsh-client-ui-plugin-governance`，避让官方 `ui-plugin-manager` 撞名）并完成 web-app 接线，Web Plugins 设置区的 governance tab（roster 徽章、生命周期/准入操作、健康面）首次可达。官方新件 sidebar Plugins 面板与之并存，两个面互补不覆盖。
- **八装件 pin 换锚至 0.1.7-rc.2 官方底座。** 八件出厂插件全部携带新供应链 pin；谱面姿态不变（6 mounted / 2 skipped）：

| 插件（id） | 包 | 版本 | Pin（40-hex git commit） |
| --- | --- | --- | --- |
| `core/webstack` | `dsh-webstack` | `0.2.0` | `289dab1b17a757bae3f170eb46b772c220471cd8` |
| `core/webstack-bridge` | `dsh-webstack-bridge` | `0.2.0` | `289dab1b17a757bae3f170eb46b772c220471cd8` |
| `core/omnivision` | `dsh-omnivision` | `0.1.0-alpha` | `d2decb2c23d527f660c1a0b97fe637e82939c966` |
| `core/filehub` | `dsh-filehub` | `0.1.0` | `b93894cf941566d0bbff6c445fa16bf083b53611` |
| `core/plugin-center` | `dsh-plugin-center` | `0.2.0` | `b9e205c7e13c49ed6580d76e79f10304d7c71f40` |
| `core/workbench` | `zdsh-workbench` | `0.1.0-beta.1` | `aab54ea646552e35ae790ec907e9a475b55afc94` |
| `core/webstack-verticals` | `dsh-webstack-verticals` | `0.2.0` | `289dab1b17a757bae3f170eb46b772c220471cd8` |
| `core/autopilot` | `dsh-autopilot` | `0.1.0` | `c5c1c040f199ab0b6b84092d1853509d915c67c5` |

## 开发者预览

zDSH 跟踪的 harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

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

首次启动时，治理预装钩子会把钉定的出厂插件谱装入本仓库的数据主目录（见[出厂插件谱](#factory-plugin-roster)）。

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

<a id="factory-plugin-roster"></a>

## 出厂插件八件谱

zDSH 以**安装态**交付：下表八件插件出厂自带、由 seed 清单（[`zdsh-factory/seed.json`](zdsh-factory/seed.json)）经治理预装钩子（`SeedPreinstaller`）在首次启动时自动装好并入册。治理面对它们可查、可管、可卸载，且已卸载的出厂插件在后续启动中永不复活（持久 `userUninstalled` 墓碑）。谱终态：**6 mounted / 2 skipped**。

| 插件（id） | 包名 | 版本 | 启动即启用 | 职能 |
| --- | --- | --- | --- | --- |
| `core/webstack` | `dsh-webstack` | `0.2.0` | `true` | 三件搜索工具（`web_backend_status` / `web_batch_search` / `web_history`）出厂注册可调；coexist 数据面随宿主选择器休眠 |
| `core/webstack-bridge` | `dsh-webstack-bridge` | `0.2.0` | `true` | webstack 族数据面链路件 |
| `core/omnivision` | `dsh-omnivision` | `0.1.0-alpha` | `true` | 视觉能力 |
| `core/filehub` | `dsh-filehub` | `0.1.0` | `true` | 文件枢纽 |
| `core/plugin-center` | `dsh-plugin-center` | `0.2.0` | `true` | 插件管理中心 |
| `core/workbench` | `zdsh-workbench` | `0.1.0-beta.1` | `true` | IDE 级停靠工作区（文件/编辑器/终端/Git/任务/浏览）；dock UI 经 dsh.client 面注入浏览器 roster |
| `core/webstack-verticals` | `dsh-webstack-verticals` | `0.2.0` | `false` | 垂直域包，包自述 opt-in |
| `core/autopilot` | `dsh-autopilot` | `0.1.0` | `false` | 产品设计默认关——由用户显式开启，属出厂最终形态，非待接线 |

## 安全

- **数据本地化** —— 自包含布局把官方模块数据、治理数据与已装插件都收拢在 `<repo>/data` 下。除非未设置 `DSH_HOME`（此时启用专属的 `~/.dsh-zdsh-go` 兜底目录），否则不写仓库目录之外的任何位置。
- **官方隔离** —— 官方版本数据位于 `~/.dsh`，zDSH-Go 的自包含布局从不写入；卸载脚本仅在显式确认后才会处理它，且从不删除 `~/.agents`。
- 运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

## 常见问题

**zDSH-Go 与 zDSH 主线是什么关系？** zDSH-Go 是 zDSH 加上一件事：以核心源码级集成落地的上下文调整。主线（[zsagi1368/deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) 的 `zdsh-latest` 分支）承载自研插件套件与上游跟踪；zDSH-Go 跟随主线，并在其之上重放上下文调整。两者独立安装、可以共存：zDSH-Go 的兜底主目录是 `~/.dsh-zdsh-go`，主线的是 `~/.dsh-zdsh`，两边的卸载脚本都不会触碰对方的数据。

**自研插件从哪里来？** 来自 zDSH 主线。zDSH-Go 继承主线的出厂 seed：首次启动时，治理预装钩子会把钉定的插件谱装入本仓库自己的数据主目录（见[出厂插件谱](#factory-plugin-roster)），其余插件经治理通道获取——`pluginGovernance.install` 解析钉定的 npm 来源，并走带确认门的准入流程。

**如何更新？** `git pull` 本仓库默认分支，然后重跑 `.\install.cmd`（Windows）或 `./scripts/install.sh`（macOS/Linux）。安装脚本会以冻结 lockfile 重装依赖并重新构建。你的 `data/` 目录保持原位。

**为什么上下文调整是源码级集成而不是插件？** 因为它改变核心行为——agent loop、会话处理、token 计量、compaction——它直接应用在核心源码上，而不是挂载为插件。插件只能待在核心旁边；缓存管理必须位于核心拥有的每条路径之内。

**会与已有的官方 DeepSeek Harness 安装冲突吗？** 不会。官方版本数据位于 `~/.dsh`，zDSH-Go 的自包含布局从不写入；卸载脚本仅在显式确认后才会处理它，且从不删除 `~/.agents`。

## zDSH 增强功能

zDSH 在官方 harness 之上加入版本自适应特性；每个特性都会探测已安装的核心，环境不匹配时干净地自我停用，因此上游漂移绝不会破坏基础产品。亮点：

- 模型槽位路由系统（`ctx.modelSlots`）。
- 带宿主钳制沙箱的项目级插件根（`ctx.projectPluginLayer`）。
- 插件治理（`ctx.pluginGovernance`）。
- 自包含安装布局——所有数据都留在仓库检出目录内。
- 出厂预装机制：seed 清单加治理预装钩子在首次启动时装好八件谱，逐件 fail-open。
- 插件治理强化：`SymbolIsolationCheck` 在治理装载链上阻断解析为双物理副本（符号隔离破损）的插件，预装复用网关准入通道，chaos 矩阵守住 fail-open 保障——单插件崩溃或畸形绝不连坐其余插件。
- 安全深审清偿一句带过：出站请求经 SSRF 四道闸（静态校验、DNS 解析核验、重定向逐跳复验、有界响应体）与逐跳 DNS 地址分类，命令载体一律绝对化（禁裸名 spawn）。

详见 [zDSH 子系统指南](docs/subsystems/zdsh.zh.md)。

## 参与贡献

贡献遵循主线的约定——参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md) 与[开发指南](docs/development.zh.md)。面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

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

---

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

- **官方社区与支持：** 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈，为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题以便被发现，或加入 [DeepSeek Harness Discord 社区](https://discord.gg/4MrtZUhpxg)。
