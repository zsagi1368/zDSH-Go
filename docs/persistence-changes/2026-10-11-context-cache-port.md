---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-11-context-cache-port

English | [中文](2026-10-11-context-cache-port.zh.md)

## Summary

Adds the context-cache ledger event (cache/ledger) and the optional returnCap property on the persisted subagent descriptor.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Both additions are established same-version cases: no Session header, event envelope, or existing value type changes. Old records carry neither addition, so every existing reader keeps its behavior. The added event type is an ordinary log record; a reader that does not know it reads the surrounding history unchanged instead of treating the record as corruption or a truncation point. The descriptor's returnCap is optional: a descriptor that omits it means unbounded settlement, which is exactly the pre-addition behavior for direct API callers, and a cold resume rebuilds that unbounded behavior rather than failing, while a descriptor that carries the value rebuilds the same cap.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/token-meter/tests/cache-metrics-ledger.spec.ts packages/core/agent-loop/tests/cache-reset-bridge.spec.ts: 6 tests passed (2 files). pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts: 167 tests passed, including the durable-descriptor persistence, the omission case, and the cold-resume cap replay.

<a id="dev-note"></a>
## Dev Note

None.
