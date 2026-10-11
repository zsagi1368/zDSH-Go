---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-28-zdsh-model-slots-dispatch

[English](2026-09-28-zdsh-model-slots-dispatch.md) | 中文

## 概述

登记承自合并前 zDSH 基线（0.1.5-rc.2 线）的 model-slots `event:slots/dispatch` 事件根：它在会话日志中记录每次辅助请求的一条模型槽位路由决策。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

该根相对官方 0.1.7-rc.2 持久化基线为纯增量——官方各根形态零变化——故确认保持同版本级别。0.1.7 的会话日志 V4 迁移本就会重初始化 0.1.7 之前的数据目录（上游 B9），不存在依赖合并前编码的存量读取方。

<a id="verification"></a>
## 验证

`pnpm run verify-persistence-changes --check` 报告每个根都有历史记录匹配；本记录 `.schema.json` 中的 slots/dispatch schema 快照即强制的变更后形态。

<a id="dev-note"></a>
## 开发备注

无。
