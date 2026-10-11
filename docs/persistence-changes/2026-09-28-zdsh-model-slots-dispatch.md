---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-28-zdsh-model-slots-dispatch

English | [中文](2026-09-28-zdsh-model-slots-dispatch.zh.md)

## Summary

Acknowledge the zDSH model-slots `event:slots/dispatch` root carried over from the pre-merge zDSH base (0.1.5-rc.2 line): it records one model-slot routing decision per auxiliary request inside the session log.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-28-zdsh-model-slots-dispatch
baseline: false
changes:
  - root: "event:slots/dispatch"
    previous: null
    after: "0157f9509d34e97fd492929b5596f7c74705e5b5209efbb2f11021d214cc98a6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The root is purely additive against the official 0.1.7-rc.2 persistence baseline — no official root changes shape — so the acknowledgement stays same-version. The 0.1.7 session-log V4 migration re-initializes pre-0.1.7 data directories anyway (upstream B9), so no carried-over reader depends on the pre-merge encoding.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence-changes --check` reports every root matched by a history record; the slots/dispatch schema snapshot in this record's `.schema.json` is the enforced after-shape.

<a id="dev-note"></a>
## Dev Note

None.
