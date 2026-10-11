---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-11-context-cache-port

[English](2026-10-11-context-cache-port.md) | 中文

## 概述

新增上下文缓存台账事件（cache/ledger），以及持久化 subagent descriptor 上的可选属性 returnCap。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-11-context-cache-port
baseline: false
changes:
  - root: "event:cache/ledger"
    previous: null
    after: "bdf704a54eae27e454f933e6781a1f00ed3b2385c18cfd23e03bac54227a89b7"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "3c9efaa7cd6b2a4137cd20c448aa63c49a4eb1a39047112360a2d1d09af5a7aa"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两项均属既定的同版本（same-version）情形：Session 头、事件信封与既有值类型均未变更。旧记录不含这两项，因此所有既有读取方行为不变。新增事件类型是普通日志记录；不认识它的读取方按原样读取周边历史，不会把该记录当作损坏或截断点。descriptor 的 returnCap 为可选：省略即表示结算不设上限，这正是新增之前对直连 API 调用方的行为，冷恢复会重建这一无上限行为而不是失败；携带该值时冷恢复重建同一上限。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/token-meter/tests/cache-metrics-ledger.spec.ts packages/core/agent-loop/tests/cache-reset-bridge.spec.ts：6 个测试通过（2 个文件）。pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts：167 个测试通过，含 descriptor 持久化、省略场景与冷恢复上限重放。

<a id="dev-note"></a>
## 开发备注

无。
