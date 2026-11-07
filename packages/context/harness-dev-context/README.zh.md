---
description: "面向 DeepSeek Harness Web GUI 用户与维护者的模型上下文：指明 DeepSeek Harness checkout 与 GUI URL，且不允许其中任何一项改变系统提示词。"
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-dev-context

[English](README.md) | 中文

## 目录

- [概述](#summary)
- [使用本包](#use-this-package)
- [冻结的旧措辞——维护职责](#frozen-legacy-wording--maintenance-duty)
- [对官方包的适配](#adaptations-from-the-official-package)
- [开发备注](#dev-note)

<a id="summary"></a>
## 概述

`dsh-harness-dev-context` 告诉运行在 DeepSeek Harness Web GUI 背后的 agent（智能体），harness 实现 checkout 位于何处、GUI 与「这个页面」是什么关系，以及由哪个 URL 提供服务。系统提示词只承载不含值的指引；当前 checkout 路径与 GUI URL 作为运行时上下文到达，因此从另一个 checkout、端口或安装启动进程绝不会改写会话已记录的系统提示词。提示词仍内嵌早期版本那些值的会话会逐字保留那段文本。

<a id="use-this-package"></a>
## 使用本包

Web 运行时的胶水插件（`@deepseek-ai/dsh-web-app`）从其 `surfaceContext` 开关挂载本插件，因此把 `surfaceContext` 关掉的一次性非交互层永远不会挂载本插件。插件本身不接受任何配置，只在所有被注入服务都存在时激活：`systemPrompt`、`sessionProjections` 与 Web 运行时的 `webApp` 服务，因此 `--help` 与非 Web 组合永远不会挂载它。

### 模型获得的内容

两个系统提示词段说明 checkout 不同于工作目录、「这个页面」指本 GUI，以及 GUI 更新约定。两行运行时上下文给出当前值：本包上方四层的安装根目录，以及来自 `webApp.getAdvertisedUrl()` 的 Web GUI 公告 URL——与 `DSH_WEB_URL` 和启动 URL 同值。

本 fork 经其 L2 delta 通道承载运行时上下文值，而非孤立的快照消息：值发生变化时追加一条 delta，折叠进下一条真实用户消息的文本前缀。前缀效果相同——追加在已缓存历史之后，绝不改写更早的消息。

### 早期版本的会话

早期版本把这两个值内嵌在系统提示词里。当会话最新的非空系统提示词仍包含那些精确段落时，提示词段会逐字重复它们（包括旧值），因此升级以及此后的端口或 checkout 变更都让该会话的提示词逐字节一致；运行时上下文行仍给出当前值。只是形似早期段落的文本会收到当前指引。

<a id="frozen-legacy-wording--maintenance-duty"></a>
## 冻结的旧措辞——维护职责

`src/index.ts` 中的 `LEGACY_SOURCE` 与 `LEGACY_WEB_SURFACE` 常量按先前版本渲染那些段落的样子冻结。**绝不与当前指引一起编辑它们**（`HARNESS_SOURCE_PROMPT` / `WEB_SURFACE_PROMPT`）：持有早期段落的会话在冻结文本改变时停止匹配，其下一次请求会改写其已记录的第一条系统消息。冻结副本有意重复今天的指引；两者可能出现分歧。未来版本更改当前指引措辞时，把退场措辞新增为一对新的冻结常量，而不是编辑现有那一对。

<a id="adaptations-from-the-official-package"></a>
## 对官方包的适配

本包在语义上逐字移植 `dsh-v0.2.2-alpha.3` 的 `packages/context/harness-dev-context`，针对本 fork 的运行时做了三处机械适配：

1. **同步投影注册表**——官方 alpha.3 注册表异步注册并返回句柄（`Promise<Handle>`，配 `handle.stateOf(session)`）；本 fork 的注册表同步注册，并经 `sessionProjections.stateOf(session, key)` 读取。因此 `apply` 是同步的，且注册仍会在读取它的各段注册之前完成。
2. **投影键声明**——本 fork 的 `SessionProjectionStateMap` 要求可合并扩展的键条目，经 module augmentation 声明（`harnessDevLegacyPrompt`）；官方 alpha.3 的仅宿主重载接受任意字符串键。
3. **`webApp` 约定所有权**——官方 web-app 组合包拥有 `WebApp` 接口与 Context 声明，且官方 bundle patch 把插件作为无条件行挂载。本 fork 的类型检查图是无环项目引用，挂载在胶水插件的 `surfaceContext` 分支中按配置门控，因此本包拥有 `WebApp` 接口与 Context 声明，胶水插件导入本包来提供服务并挂载插件。

<a id="dev-note"></a>
### 开发备注

本开发备注是不具权威性的工作上下文：未定方向与维护者备注。已交付的行为与既定理由见上文各节、包代码与移植记录（CTX-IMP-20261104 T5 证据：`zDSH-docs/R&D/ctx-imp-20261104/artifacts/T5-evidence.md`）。开放维护事项：四象限 A1 对齐的回归检查清单随规范存放；收益量级估算（P-D5-7）是产品门禁的输入，尚未有会话级样本支撑。
