---
description: "Host-side plugin governance service: registry mirror, lifecycle, health, admission, and preset operations published as a typed Remote."
kind: "package-reference"
---

# dsh-plugin-governance-host

English | [中文](README.zh.md)

## Summary

宿主面治理服务：注册表镜像、生命周期、健康、准入与预设操作，以类型化 Remote 发布。

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

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

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Loader 镜像仅覆盖已挂载条目；安装目录清理为 best-effort。
- npm 来源仅接受精确版本（无范围解析）。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

#### Future: range resolution for npm sources

The npm admission path intentionally accepts exact versions only. Range resolution would need a resolved-lock story before admission so that a re-install cannot silently upgrade a governed plugin; until that lands, exact pins keep the admission ledger reproducible.

**Runtime invariant:** No companion is published because every state change flows through one Remote method that validates its arguments at the entry and returns a closed result union; there is no background event stream or cross-service relation to assert against.

</details>
