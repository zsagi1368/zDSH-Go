---
description: "面向 fork/upstream 漂移的版本自适应垫片框架：动态 API 形状探测、功能守卫与进程级兼容名册。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compat

[English](README.md) | 中文

## 概述

面向 fork/upstream 漂移的版本自适应垫片框架。它是唯一被允许动态探测官方核心 API 形状的层；其余每个 zDSH 功能包都通过它对自己的注册做闸门控制——探测其所依赖的符号，检测到冲突时自动禁用，而不是在宿主部分加载或上游漂移的启动过程中抛错。`dsh-compat` 零运行时依赖，当前被七个功能包共用（`dsh-acp`、`ui-settings-models`、`workbench`、`dsh-llm`、`dsh-model-slots`、`dsh-plugin-governance`、`dsh-plugin-project-root`）。

## 目录

- [API](#api)
- [设计约束](#design-constraints)
- [开发备注](#dev-note)

-----

<a id="api"></a>
## API

### probeSymbol

`probeSymbol<T>(specifier, symbol, shape?)` 动态导入 `specifier`，报告 `symbol` 是否被导出并通过可选的 `shape` 校验器。它永不抛错；每次失败都被归类为四种 `ProbeReason` 之一：

- `module-not-found` —— 说明符无法解析（未安装 / 未导出）。
- `symbol-missing` —— 模块可导入，但具名导出缺失。
- `shape-mismatch` —— 符号存在，但未通过 shape 校验。
- `import-threw` —— 动态 import 本身抛错（模块求值异常等）。

```ts
import { probeSymbol } from '@deepseek-ai/dsh-compat'

const result = await probeSymbol('node:fs', 'readFile', (v: unknown) => typeof v === 'function')
// present === true, value is the readFile function
```

### memberOf

`memberOf<T>(namespace, symbol)` 同步读取已加载模块命名空间的导出形状（非动态 import），用于静态别名场景。返回符号值或 `undefined`。

```ts
import { memberOf } from '@deepseek-ai/dsh-compat'

const value = memberOf({ answer: 42 }, 'answer')
// value === 42
```

### versionOf

`versionOf(packageName)` 从宿主侧读取已安装包的 `version` 字段；任何失败都返回 `undefined` 而不是抛错。用于区分版本档位（如官方 `0.1.2-alpha.1` 与 zDSH `0.1.1-rc.2`）。

```ts
import { versionOf } from '@deepseek-ai/dsh-compat'

const version = await versionOf('@deepseek-ai/dsh-llm')
// version === '0.1.1-rc.2'
```

### guardFeature

`guardFeature(featureId, options)` 在 fork 功能注册自身之前运行。先跑 `deps`（依赖探测），再跑 `check`（冲突检查）；第一个失败即禁用该功能并短路剩余检查。以 `[compat] <logPrefix> disabled: <failures>` 记录一条警告，并把判定写入进程级名册。它永不抛错——抛错的 `run` 计为失败，reason 为 `threw:<message>`。

```ts
import { consoleCompatLogger, guardFeature } from '@deepseek-ai/dsh-compat'

const verdict = await guardFeature('dsh-project-root', {
  deps: [
    {
      name: 'cordis:Service',
      run: async () => {
        const { Service } = await import('@deepseek-ai/cordis')
        return typeof Service === 'function' ? null : 'Service not a function'
      },
    },
  ],
  logger: consoleCompatLogger(),
})
if (!verdict.enabled) {
  // skip registration; verdict.reason / verdict.failures explain why
}
```

### getCompatRoster

`getCompatRoster()` 返回进程级审计名册的只读快照：对每个被守卫的功能 id，记录 `{ enabled, reason, checkedAt }`。修改快照不会影响后续检查。

```ts
import { getCompatRoster } from '@deepseek-ai/dsh-compat'

const roster = getCompatRoster()
const entry = roster.get('dsh-model-slots')
// entry?.enabled, entry?.reason, entry?.checkedAt
```

<a id="design-constraints"></a>
## 设计约束

- 零运行时依赖：`package.json` 声明了空的 `dependencies` 字段。
- `dsh-compat` 是唯一允许动态探测官方核心 API 的层；消费方通过 `guardFeature` 注册，绝不自作主张探测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包有意冻结在零运行时依赖与封闭的四值 `ProbeReason` 分类上：新的探测应放在功能包内并经由 `guardFeature`，拓宽 `dsh-compat` 自身的导入范围会侵蚀单一探测层的立场。

</details>
