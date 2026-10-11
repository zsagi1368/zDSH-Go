---
description: "宿主侧插件治理服务：注册表镜像、生命周期、健康、准入与预设操作，以类型化 Remote 发布。"
kind: "package-reference"
---

# dsh-plugin-governance-host（中文）

[English](README.md) | 中文

## 概述

宿主面治理服务：注册表镜像、生命周期、健康、准入与预设操作，以类型化 Remote 发布。

## 目录

- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Governance gateway

#### What the model sees

服务键 `pluginGovernance`：`list`/`get`/`health` 只读投影，`approve` 与 preset 操作，`install`/`uninstall` 准入管线（本地目录与 npm 来源）。

##### Remote surface

```markdown
pluginGovernance.list(): GovernanceRosterSnapshot
pluginGovernance.install({ source }): GovernanceAcknowledgement
```

#### Token effect

仅按调用返回结果；不注入固定 prompt 文本。

#### KV Cache effect

无：注册表镜像与审批账本经耐久快照/台账落盘，不依赖 KV 缓存。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Loader 镜像仅覆盖已挂载条目；安装目录清理为 best-effort。
- npm 来源仅接受精确版本（无范围解析）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：未决的设计问题与方向。它明确非权威——已交付的行为、限制与既定理由见上文各节、包代码及关联 Agent Note。

#### 未来：npm 来源的范围解析

npm 准入路径有意只接受精确版本。范围解析需要先有准入前的 resolved-lock 方案，否则重装可能静默升级一个受治理的插件；在此之前，精确固定让准入台账可复现。

</details>
