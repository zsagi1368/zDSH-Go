/**
 * L2↔L5 重置事件桥集成测试（Phase 6 + B2 断链修复）：tailMerge 触发时通过
 * DeltaResetSink 写入 cache-guardian ResetLedger 并持久化进会话日志
 * （cache/ledger 事件，携带**本次重置的增量** `resetWriteCost`）；带种子重建的
 * agent 从日志恢复台账，后续重置代数递增。
 *
 * B2 修复的端到端不变量（本测试的核心断言）：token-meter `cacheMetrics` 投影的
 * `resetWriteTokens` 必须等于会话日志中所有 `cache/ledger` 事件增量之和——即
 * agent 侧 `totalResetWriteCost` 的同一份 Σ（单一权威账）。修复前投影 `apply` 无
 * `cache/ledger` 分支、`foldResetWriteCost` 生产侧从不调用，投影恒报 0（断链）。
 * resume（种子重建）后重放同一批事件，投影值与持久化账本一致。
 *
 * 触发方式：一次 register 内两个动态上下文同时变化 → 两个 delta 区间、总长超
 * 阈值 → 尾部合并。折叠（foldInto）在 preStep 后消费 delta，因此单上下文变化不会
 * 累积到合并线；两个上下文同轮变化才能在同一次 register 里形成 ≥2 区间。
 *
 * 运行环境：本测试依赖完整宿主闭包（`@deepseek-ai/dsh-agent-loop` 的
 * `createAgent`/`seed` 服务、`dsh-session-projection`、`dsh-token-meter`），在
 * fork workspace 运行；独立插件轨的纯函数投影不变量见
 * `packages/llm/token-meter/tests/cache-metrics-ledger.spec.ts`。
 *
 * @module @deepseek-ai/dsh-agent-loop/tests/cache-reset-bridge
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { deserializeLedger } from '@deepseek-ai/dsh-llm-pi-ai/cache-guardian'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** `cache/ledger` 事件（收窄联合，便于读 `data.ledger` / `data.resetWriteCost`）。 */
type CacheLedgerEvent = Extract<SessionEvent, { type: 'cache/ledger' }>
const isCacheLedger = (event: SessionEvent): event is CacheLedgerEvent => event.type === 'cache/ledger'

/** 会话日志中所有 `cache/ledger` 事件增量之和（agent 侧 totalResetWriteCost 的同一份 Σ）。 */
function sumLedgerDeltas(session: Session): number {
  let sum = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'cache/ledger') sum += event.data.resetWriteCost
  }
  return sum
}

/** 读取 cacheMetrics 投影的 resetWriteTokens。 */
function projectedResetWriteTokens(ctx: Context, session: Session): number {
  const value = ctx.sessionProjections.snapshot(session).values.cacheMetrics
  if (value === undefined) throw new Error('cacheMetrics projection is not registered')
  return value.resetWriteTokens
}

describe('L2↔L5 cache reset bridge (Phase 6 + B2 ledger link)', () => {
  it('persists per-reset cache/ledger deltas, links them into the cacheMetrics projection, and rebuilds both on a seeded agent', async () => {
    // 两个动态上下文，每次 assembly 增长：
    //   第 1 次登记：X=5000, Y=3000 → 1 段 delta（SOURCE），不合并
    //   第 2 次登记：X=9000, Y=6000 → 2 段 delta（X、Y），总长 15000 > 8192 → 合并 → 写 cache/ledger
    //   种子重建后第 1 次登记：X=13000, Y=9000 → 2 段 delta，总长 22000 > 8192 → 再合并 → 代数 2（证明恢复）
    let xCalls = 0
    let yCalls = 0
    const contextX = (): string => { xCalls += 1; return 'X'.repeat(5000 + (xCalls - 1) * 4000) }
    const contextY = (): string => { yCalls += 1; return 'Y'.repeat(3000 + (yCalls - 1) * 3000) }

    const adapter = new MockAdapter([
      textResponse('ok'),
      textResponse('ok'),
      textResponse('ok'),
    ])
    const ctx = await harness(adapter)
    ctx.systemPrompt.context({ name: 'test:x', order: 50, text: contextX })
    ctx.systemPrompt.context({ name: 'test:y', order: 60, text: contextY })

    // agent A：两步驱动触发第一次合并。
    const agentA = await ctx.agentLoop.create(SessionId('cache-bridge-a'), { provider: 'mock', model: 'mock' })
    agentA.followup(createUserMessage({ content: [{ type: 'text', text: 'step 1' }], source: { kind: 'user' } }))
    await agentA.whenIdle()
    agentA.followup(createUserMessage({ content: [{ type: 'text', text: 'step 2' }], source: { kind: 'user' } }))
    await agentA.whenIdle()

    const ledgerEvents = agentA.session.snapshotEvents().filter(isCacheLedger)
    expect(ledgerEvents.length).toBeGreaterThanOrEqual(1)
    const firstLedger = ledgerEvents[ledgerEvents.length - 1]!
    const ledgerA = deserializeLedger(firstLedger.data.ledger)
    expect(ledgerA).toBeDefined()
    expect(ledgerA!.events.at(-1)?.type).toBe('mergeRewrite')
    expect(ledgerA!.generation).toBe(1)
    // 记账：mock provider（非 deepseek/anthropic）η=1.25，末条增量 = round(η ×
    // ceil(重置时点上下文/4)) > 0。
    expect(firstLedger.data.resetWriteCost).toBeGreaterThan(0)

    // B2 链路核心断言：投影 resetWriteTokens === 会话日志所有 cache/ledger 增量之和。
    // 修复前此处投影恒为 0（apply 无 cache/ledger 分支），断链。
    const agentASum = sumLedgerDeltas(agentA.session)
    expect(agentASum).toBeGreaterThan(0)
    expect(projectedResetWriteTokens(ctx, agentA.session)).toBe(agentASum)

    // 种子重建（等价 resume）：新 agent 从日志回放恢复台账。
    const agentB = (await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('cache-bridge-b'),
      seed: agentA.session.snapshotEvents(),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    agentB.followup(createUserMessage({ content: [{ type: 'text', text: 'step 3' }], source: { kind: 'user' } }))
    await agentB.whenIdle()

    const ledgerEventsB = agentB.session.snapshotEvents().filter(isCacheLedger)
    expect(ledgerEventsB.length).toBeGreaterThanOrEqual(2)
    const lastLedgerB = ledgerEventsB[ledgerEventsB.length - 1]!
    const ledgerB = deserializeLedger(lastLedgerB.data.ledger)
    expect(ledgerB).toBeDefined()
    // 代数比 agent A 的多一次：证明台账从日志恢复后继续追加，而非从空重建。
    expect(ledgerB!.generation).toBe(ledgerA!.generation + 1)
    expect(ledgerB!.events.length).toBe(ledgerA!.events.length + 1)

    // resume 后「值一致」：投影 resetWriteTokens 仍等于 B 日志（种子 A 事件 + B 新事件）
    // 所有 cache/ledger 增量之和；且严格大于 A 的累计（多一次合并的增量已折入）。
    const agentBSum = sumLedgerDeltas(agentB.session)
    expect(projectedResetWriteTokens(ctx, agentB.session)).toBe(agentBSum)
    expect(agentBSum).toBeGreaterThan(agentASum)
  }, 30000)
})
