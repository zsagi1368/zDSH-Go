---
description: "Web Plugins 设置内的治理标签页：评分徽章、生命周期与准入操作、健康计数与预设。"
kind: "package-reference"
---

# dsh-client-ui-plugin-governance（中文）

[English](README.md) | 中文

## 概述

治理标签页位于 Web Plugins 设置区，承载每个受治理插件的名单、生命周期、准入、健康与预设。它通过 `pluginGovernance.list` 投影名单行，提供 `approve`/`enable`/`disable` 远程操作，并支持治理预设的保存/加载/删除。当浏览器 UI 需要在无终端环境下操作插件治理主机时选择本包。

## 目录

- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 治理名单

#### 模型所见

名单行经 `pluginGovernance.list` 投影：每行携带来源与准入状态；操作走 `approve`/`enable`/`disable` 远程面。

##### 名单视图

```markdown
roster row -> { pluginId, source, approvalRequired, approved, status }
```

#### Token 效果

仅查询时装配名单行；不注入固定 prompt 文本，不产生会话事件。

#### KV 缓存效果

无：本包不读写 KV 缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 插件远程安装（npm 来源）的 UI 接线尚未实现，服务端已具备。
- 预设编辑器仅支持保存/加载/删除，不支持可视化编排。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：未决的设计问题与方向。它明确非权威——已交付的行为、限制与既定理由见上文各节、包代码及关联 Agent Note。

#### 未来：可视化预设编排

预设编辑器有意仅提供保存/加载/删除。可视化编辑器需要为 `PresetNameRequest` 风格载荷提供 schema 驱动表单；治理主机已暴露完整预设面，因此这纯属客户端投入。

</details>
