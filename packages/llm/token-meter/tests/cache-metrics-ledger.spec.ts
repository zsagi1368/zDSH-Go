/**
 * B2 断链修复 —— 投影侧「单一权威账」不变量（纯函数，无需 cordis 宿主）。
 *
 * 本文件刻意只 `import type` 宿主类型（运行时擦除），值导入仅 `../src/cache-metrics.ts`
 * （其运行时依赖只有 `zod`），因此可在独立插件轨与 fork workspace 两处运行；
 * 与依赖完整宿主闭包的 `cache-metrics.spec.ts`（cordis harness）互补。
 *
 * 不变量：`cache/ledger` 事件携带**单次重置的增量** `resetWriteCost`
 * （agent 侧 `accountResetCost(contextTokens, η)` 的结果），投影 `apply` 经
 * `foldResetWriteCost` 逐条累加成 `resetWriteTokens`。这条账与 agent 侧
 * `totalResetWriteCost`（对同一批事件增量求和）恒等——修复前投影 `apply` 无
 * `cache/ledger` 分支、`foldResetWriteCost` 生产侧从不调用，投影恒报 0（断链）。
 *
 * @module @deepseek-ai/dsh-token-meter/tests/cache-metrics-ledger
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { cacheMetricsProjectionDefinition } from '../src/cache-metrics.ts'

const { apply, init } = cacheMetricsProjectionDefinition

/** 构造一条 `cache/ledger` 事件（仅携带本次重置增量）。 */
function cacheLedgerEvent(resetWriteCost: number): SessionEvent {
  return { type: 'cache/ledger', data: { ledger: '{}', resetWriteCost } } as SessionEvent
}

/** 复刻 cache-guardian.accountResetCost：round(η × contextTokens)。 */
function accountResetCost(contextTokens: number, eta: number): number {
  return Math.round(contextTokens * eta)
}

/** 从 init 起按顺序 fold 一批 cache/ledger 事件，返回最终 state。 */
function foldEvents(events: readonly SessionEvent[]): ReturnType<typeof init> {
  return events.reduce((state, event) => apply(state, event), init())
}

describe('cacheMetrics reset-write cost ledger (B2 single authoritative ledger)', () => {
  it('folds each cache/ledger delta into resetWriteTokens', () => {
    const state = foldEvents([cacheLedgerEvent(1250), cacheLedgerEvent(2000)])
    expect(state.resetWriteTokens).toBe(3250)
  })

  it('accumulates the same Σ the agent loop persists (η×context per reset)', () => {
    // 三次 tailMerge，各自 contextTokens 与 η；agent 侧 totalResetWriteCost
    // = Σ accountResetCost。投影对同一批增量 fold，两视图必须恒等。
    const resets = [
      { contextTokens: 9000, eta: 1.25 },
      { contextTokens: 12000, eta: 1.25 },
      { contextTokens: 4000, eta: 2.0 },
    ]
    const agentTotal = resets.reduce((sum, r) => sum + accountResetCost(r.contextTokens, r.eta), 0)
    const state = foldEvents(resets.map(r => cacheLedgerEvent(accountResetCost(r.contextTokens, r.eta))))
    expect(state.resetWriteTokens).toBe(agentTotal)
    expect(state.resetWriteTokens).toBe(11250 + 15000 + 8000)
  })

  it('is replay-deterministic: re-folding the same events yields the same total (resume equivalence)', () => {
    const events = [cacheLedgerEvent(1000), cacheLedgerEvent(2500), cacheLedgerEvent(750)]
    const live = foldEvents(events)
    // 模拟 resume：从 init 重放同一批事件，值必须一致。
    const resumed = foldEvents(events)
    expect(resumed.resetWriteTokens).toBe(live.resetWriteTokens)
    expect(resumed.resetWriteTokens).toBe(4250)
  })

  it('treats cache/ledger as cost accounting only: no warm-up latch, no reset count', () => {
    const before = init()
    const after = apply(before, cacheLedgerEvent(5000))
    expect(after.resetWriteTokens).toBe(5000)
    expect(after.resetCount).toBe(before.resetCount)
    expect(after.pendingWarmUp).toBe(before.pendingWarmUp)
    expect(after.warmUpCount).toBe(before.warmUpCount)
    expect(after.mainChainRequests).toBe(before.mainChainRequests)
  })

  it('leaves state untouched for a zero / non-finite delta (contextTokens undefined path)', () => {
    // agent 侧 contextTokens 未定义时增量记 0（仍写 cache/ledger 快照）。
    const base = foldEvents([cacheLedgerEvent(300)])
    expect(apply(base, cacheLedgerEvent(0))).toBe(base)
    expect(apply(base, cacheLedgerEvent(Number.NaN))).toBe(base)
    expect(apply(base, cacheLedgerEvent(-5))).toBe(base)
  })
})
