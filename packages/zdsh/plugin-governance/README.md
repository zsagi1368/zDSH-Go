---
description: "Plugin governance spec and kernel: spec, registry, guards, sandbox, Cordis adapter, and persistence."
kind: "package-reference"
---

# dsh-plugin-governance

English | [中文](README.zh.md)

## Summary

治理规范与内核：spec/registry/guards/sandbox/Cordis 适配器/持久化。

## Table of Contents

- [Version adaptation (compat guard)](#version-adaptation-compat-guard)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Model Experience](#model-experience)
- [Dev Note](#dev-note)

-----

<a id="version-adaptation-compat-guard"></a>
## Version adaptation (compat guard)

The sandbox gates its own registration through `@deepseek-ai/dsh-compat`'s `guardFeature` (`guardGovernance` in `src/compat.ts`), probing the peer symbols it depends on before mounting:

- `cordis:Service` — `@deepseek-ai/cordis` must export a callable `Service`.
- `governance:LoadGuard` — `@deepseek-ai/dsh-plugin-governance` must export a callable `LoadGuard`.

When any probe fails, the guard logs a warning and returns `false`, so the sandbox skips registration instead of throwing. It never throws and never breaks the host tree: a partially-loaded or upstream-drifted host simply boots without the sandbox.

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

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- LoadGuard 对弱畸形清单（空格 id、空能力表）采取容忍策略，硬性拦截面为版本兼容与沙箱形状校验。
- 运行时资源限制依赖调用方执行守卫，不强制挂载。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

#### Future: enforced runtime resource limits

Runtime resource limits currently rely on callers honoring the guard verdicts. A kernel-enforced mount would let `RunGuard` own the enforcement itself; that is deferred until at least two concrete consumers exist, so the kernel does not grow a policy surface ahead of its users.

</details>
