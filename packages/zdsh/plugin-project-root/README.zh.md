---
description: "DeepSeek Harness 的项目级插件根：从 <projectRoot>/.dsh/plugins 发现插件，经宿主钳制沙箱、门控、信任 ledger 与 post-boot Cordis 层挂载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-project-root

[English](README.md) | 中文

## 概述

DeepSeek Harness 的项目级插件根（S-43 M1 + M2a + M2b）。插件从 `<projectRoot>/.dsh/plugins/<id>/` 被发现，经宿主钳制、门控、ledger 过滤后，在 post-boot 以 Cordis 层（`ctx.projectPluginLayer`）挂载。本模块中的每个值都是服务端（宿主）构造：UI 负责渲染，从不自行推断。

## 目录

- [能力](#capabilities)
- [设计依据](#design-basis)
- [兼容守卫](#compatibility-guard)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="capabilities"></a>
## 能力

- **发现**（`discoverProjectPlugins`）：在 `findProjectRoot` 找到的项目根（最近的带 `.git` 祖先，否则 `cwd`）之下扫描 `<root>/.dsh/plugins/<id>/`。符号链接/联结条目以指名路径的警告被拒绝（A-04）；清单畸形或不完整则跳过该候选并给出警告，绝不导致启动失败（A-05）。候选是普通对象——任何内容都不会被序列化为 YAML，因此 `!!js` 表达式注入没有攻击面（A-06/A7.4）。`pluginDir` 在使用前先做 realpath。
- **宿主钳制**（`clampProjectPluginSandbox`）：清单沙箱是申请；钳制产出生效沙箱，对超出项目插件边界的声明值予以拒绝（B-01 `fullyAuthorized`/`spawn`/`exec`，B-03 `llm-adapter` 能力及任何非 `none` 的 `network.access`）或收窄（内存/超时封顶于 `PROJECT_PLUGIN_HOST_CAPS` 512 MiB / 60 秒，文件系统 `allowedPaths` 与插件目录求交集，fail-closed）。M2b 授予声明的 `process`/`worker` 档位（`runtimeTier: 'subprocess'`）；`inline` 保持 M2a 进程内运行时。
- **门控**（`gate`）：每个候选依次执行钳制 + `LoadGuard.preLoad`（内核版本 `0.1.1-rc.2`）+ 能力拒绝，产出 `{ accepted, report }` 与完整判定审计轨迹（`rejected`/`warned`/`mounted`/`mount-failed`）。
- **信任 ledger**（`data/project-trusts.json`）：持久的 根 × 插件 决策。缺失或损坏的 ledger 读作空（fail closed——在操作者记录决策之前什么都不挂载）。信任是项目根的性质，由发现者赋予；被发现的文件绝不自我报告信任。项目插件从不进入 registry 的 `persistedDecisions` 机制；本 ledger 是它们唯一的决策存储。
- **post-boot 挂载隔离**（`mountProjectPlugins` / `createProjectPluginLayer`）：开关（`project-plugins.config.enabled`，无环境变量键）在任何发现之前检查——关闭时零文件系统读取（A-01/A-02）。挂载是串行且 post-boot 的，每次 `ctx.loader.create` 都被 try/catch 隔离（B-07）；工具集在每次 create 前后快照，新注册的工具据此归因到引入它的插件；origin 在治理镜像能看到该条目之前就记录。项目条目永不进入 include patch tree。
- **RunGuard 接线**：每个挂载的插件都注册 watcher（B-08），每个项目工具调用都经 `tools/execute` 包装器（`projectToolWrapper`）走 `runGuard.execute`；非项目工具零行为变化地通过（D-01）。`PluginTimeoutError`/`PluginError` 映射为结构化的 `isError` 结果，绝不以抛出的异常呈现。
- **子进程运行时**（`createSubprocessRuntime`，M2b）：`process`/`worker` 档位在带 OS 边界的子进程或 worker 线程中运行。bootstrap 以字符串生成，内联绝对 `file://` URL（子进程侧无需裸说明符解析）；超时即杀死子进程（SIGKILL/`terminate`），回收挂起的执行体（B-06）；内存经 `--max-old-space-size` 或 Worker `resourceLimits` 强制；只有清单声明的工具名能通过 IPC 白名单；环境经 `deriveSandboxEnvironment` 过滤（B-09）。
- **会话作用域**（`wireSessionScope`，M3/C-03）：每个项目工具绑定到其所属项目根；对每个会话 `cwd` 未命中该根（`cwdHitsProjectRoot`）的存活 agent，该工具经 `agent.ctx.tools.restrict({ deny: [...] })` 被限制移除，包装器中的执行时 cwd 检查作为纵深防御。新 agent 由 `agent/created` 监听覆盖。
- **UI 徽标**：`runtimeTier`（`in-process` / `subprocess`）是名册/UI 显示字段；层暴露 `isSubprocess(pluginId)`、`subprocessEntryIds()` 与 origin（`originOf`）供 UI 渲染。

<a id="design-basis"></a>
## 设计依据

R-S43 红队裁决的三个条件均已落实：(1) 自声明不再自动授予任何权限——声明的沙箱是申请，宿主钳制决定结果（R-S43 前提 B，fail-closed 落回白名单检查）；(2) `untrusted` 已从沙箱词汇中移除，信任只存在于项目根 ledger；(3) 每个项目工具都限定在其所属项目根内，注册时与执行时双重强制。

<a id="compatibility-guard"></a>
## 兼容守卫

`guardProjectRoot()` 包装 `@deepseek-ai/dsh-compat` 的 `guardFeature`：在插件注册前探测对等符号（`cordis:Service`、`governance:LoadGuard`、`tools:defineTool`），任一探测失败即返回 `false`（永不抛错），使部分加载或上游漂移的宿主优雅降级。按 COMPAT-DESIGN §4.5，只检查核心符号的存在性，绝不检查其内部实现。

```ts
import { guardProjectRoot } from '@deepseek-ai/dsh-plugin-project-root/src/compat.ts'

const enabled = await guardProjectRoot()
if (!enabled) {
  // skip registration; do not throw
}
```

<a id="model-experience"></a>
## 模型体验

无。本包是宿主侧的发现、钳制、门控与挂载基础设施；它所挂载的项目插件自身拥有它们所做的每一个模型侧注册。

#### KV Cache 效应

无；信任 ledger 与挂载流水线不发送任何 provider 请求，也不进入任何模型上下文。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **会话作用域之外的 M3 里程碑尚未定界** —— 更丰富的名册投影、按插件资源核算、ledger 迁移工具，均延后至 S-45 设置里程碑确定操作者如何编辑信任决策之后。
- **钳制是固定的宿主边界** —— 项目插件永远无法重新获得宿主钳制移除的能力；需要更宽能力的包应属于用户插件层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：未决的设计问题与方向。它明确非权威——已交付的行为、限制与既定理由见上文各节、包代码及关联 Agent Note。

#### 未来：会话作用域之外的 M3 里程碑

会话作用域（M3/C-03）把工具绑定到所属项目根；更多里程碑工作——更丰富的名册投影、按插件的资源核算、ledger 迁移工具——有意保持未定范围，直到 S-45 settings 里程碑确定操作者如何编辑信任决策。

</details>
