---
description: "Cordis 服务，为所有辅助侧任务模型调用提供统一路由词汇：固定槽位、部署级回退与持久的派发归因。"
kind: "package-reference"
---

# `@deepseek-ai/dsh-model-slots`

[English](README.md) | 中文

## 概述

Cordis 服务（`ctx.modelSlots`），为所有辅助侧任务模型调用提供统一的路由词汇。部署方按内置槽位（`title`、`compaction.summarize`）逐一指明精确的 `provider`/`model` 路由并配以 `fallback` 默认；每个取值必须是完整配对，词汇之外的槽位 id 会在启动时失败。`resolve(slot, input)` 依次取槽位、部署默认或调用方主模型路由中第一个可用项，无一可用时返回 `null`。每次带 `session` 汇的成功解析都会追加一条持久的仅日志事件 `slots/dispatch`，把该次调用归因到它实际使用的路由。

## 目录

- [版本适配（compat 守卫）](#version-adaptation-compat-guard)
- [模型体验](#model-experience)
- [已知限制与遗留工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="version-adaptation-compat-guard"></a>
## 版本适配（compat 守卫）

本功能通过 `@deepseek-ai/dsh-compat` 的 `guardFeature` 探测其对等表面（`src/compat.ts` 中的 `guardModelSlots`），并把判定写入进程级审计名册：

- `cordis:Service` —— `@deepseek-ai/cordis` 必须导出可调用的 `Service`。
- `settings:forms` —— `@deepseek-ai/dsh-settings` 必须导出条目派生的 `SettingsForms` 面（其原型提供 `describe`/`update`/`mutate`）。它取代了已退役的 `SettingsProvider` 注册面，是用户层槽位覆写写入时所经的面。

探测失败时守卫记录一条警告并返回 `false`，名册给出可归因的 reason；注册本体在所有宿主上照常进行并继续服务组合层配置，因此缺少该面的宿主只失去「可由设置写入的用户层」。守卫永不抛错、永不破坏宿主树。

<a id="model-experience"></a>
## Model Experience

间接地，通过在此解析辅助派发路由的消费方体现：本服务只选择侧任务请求使用的 provider/model 对，而请求组装与 provider 适配器拥有模型可见的一切。

#### KV Cache 效应

解析本身不发送请求，也不改变上下文。所选路由决定一次辅助调用落入哪个 provider 缓存：稳定的按槽位声明让连续的辅助请求保持在同一条温热路由上；缺少声明时则跟随会话的主模型路由，共享其缓存行为。修改配置会把后续辅助调用重新指向新路由，并使先前路由持有的前缀复用失效；`slots/dispatch` 记录仅入日志，永不进入模型上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与遗留工作

- **槽位 id 是封闭的内置集合** —— 词汇只随经过评审的消费方增长，部署方暂不能命名自定义槽位；`vision`、`plan` 等槽位推迟到各自的路由集成落地后加入。
- **用户层即条目自身的 Config** —— 槽位路由来自 `llm-model-slots` 这一 profile 行；经设置面编辑时，用户层写入同一 entry：两个策略字段均为 volatile，写入会就地提交到运行中的 entry，后续辅助调用随之改道而无需重挂载。Models 页的槽位区块与 settings 镜像只寻址该 entry id；以其他 id 挂载的部署行仍服务其组合层配置，但不带可由设置写入的用户层。项目级覆盖在安全评审前仍不在范围内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：未决的设计问题与方向。它明确非权威——已交付的行为、限制与既定理由见上文各节、包代码及关联 Agent Note。

#### 未来：更细的用户层策略语义

`slots` 与 `fallback` 是整体 volatile 字段：按路径寻址的设置编辑合并进运行中的 entry，整体节替换则重写整份策略；被拒绝的策略只警告一次并保留先前路由。是否在组合层之上再设更细的按槽位合并层、以及项目级覆盖如何与之组合，仍未决定。

</details>
