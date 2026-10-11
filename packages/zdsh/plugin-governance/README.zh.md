---
description: "插件治理规范与内核：spec、registry、guards、sandbox、Cordis 适配器与持久化。"
kind: "package-reference"
---

# dsh-plugin-governance（中文）

[English](README.md) | 中文

## 概述

治理规范与内核：spec/registry/guards/sandbox/Cordis 适配器/持久化。

## 目录

- [版本适配（compat 守卫）](#version-adaptation-compat-guard)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [模型体验](#model-experience)
- [开发备注](#dev-note)

-----

<a id="version-adaptation-compat-guard"></a>
## 版本适配（compat 守卫）

沙箱通过 `@deepseek-ai/dsh-compat` 的 `guardFeature` 对自己的注册做闸门控制（`src/compat.ts` 中的 `guardGovernance`），在挂载前探测它所依赖的对等符号：

- `cordis:Service` —— `@deepseek-ai/cordis` 必须导出可调用的 `Service`。
- `governance:LoadGuard` —— `@deepseek-ai/dsh-plugin-governance` 必须导出可调用的 `LoadGuard`。

任一探测失败时，守卫记录一条警告并返回 `false`，沙箱随之跳过注册而不是抛错。它永不抛错、永不破坏宿主树：部分加载或上游漂移的宿主只是不带沙箱完成启动。

<a id="model-experience"></a>
## Model Experience

### Guard kernel

#### What the model sees

`LoadGuard#preLoad`、`RunGuard#execute` 与 `HealthGuard` 构成守卫语义：加载拒面、超时切断、连续失败升级禁用。

##### Guard contract

```markdown
LoadGuard.preLoad(plugin, kernelVersion): LoadResult { allowed, failures }
```

#### Token effect

内核本身不接触模型上下文；token 影响完全由消费方决定。

#### KV Cache effect

无：持久化走 registry.json/approvals.json 快照，无 KV 参与。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- LoadGuard 对弱畸形清单（空格 id、空能力表）采取容忍策略，硬性拦截面为版本兼容与沙箱形状校验。
- 运行时资源限制依赖调用方执行守卫，不强制挂载。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：未决的设计问题与方向。它明确非权威——已交付的行为、限制与既定理由见上文各节、包代码及关联 Agent Note。

#### 未来：内核强制的运行时资源限制

运行时资源限制目前依赖调用方执行守卫判定。内核强制的挂载会让 `RunGuard` 自己持有执行权；这推迟到至少出现两个具体消费方之后，避免内核在用户出现前先长出策略面。

</details>
