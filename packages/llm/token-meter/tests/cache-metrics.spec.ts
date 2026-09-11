/**
 * Cache-metrics projection: hit-rate domain, reset/warm-up classification,
 * and compression-equivalence ledger.
 *
 * @module dsh-token-meter/tests/cache-metrics
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { CacheMetricsProjection } from '@deepseek-ai/dsh-token-meter/client'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import {
  cacheMetricsProjectionDefinition,
  compressionEquivalenceWithinBudget,
  foldResetWriteCost,
  sloTarget,
} from '../src/cache-metrics.ts'

const CONFIG = { provider: 'test', model: 'test-model' }

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

const projected = (ctx: Context, session: Session): CacheMetricsProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.cacheMetrics
  if (value === undefined) throw new Error('cacheMetrics projection is not registered')
  return value
}

/** Append a `request/header` with the given reason. */
function appendHeader(
  session: Session,
  reason: 'initial' | 'resume' | 'change' = 'initial',
  overrides: Partial<{ provider: string; model: string }> = {},
): void {
  session.append('request/header', {
    header: {
      config: { provider: overrides.provider ?? CONFIG.provider, model: overrides.model ?? CONFIG.model },
    },
    reason,
  })
}

/** Append one assistant turn carrying provider usage. */
function appendAssistant(
  session: Session,
  turn: number,
  step: number,
  usage: TokenUsage,
): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  session.append('assistant/message', { stream: [],
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append a compaction/summary with a given shadowed token count. */
function appendCompactionSummary(session: Session, shadowedTokenCount: number): void {
  session.append('compaction/summary', {
    compactionId: CompactionId('test'),
    summary: [{ type: 'text', text: 's' }],
    shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) },
    shadowedSeqs: [SessionSeq(0)],
    shadowedTokenCount,
    provider: CONFIG.provider,
    model: CONFIG.model,
  })
}

describe('cacheMetrics projection', () => {
  it('serves zeros for an empty log', async () => {
    const { ctx, session } = await harness()
    const m = projected(ctx, session)
    expect(m.mainChainRequests).toBe(0)
    expect(m.mainChainHits).toBe(0)
    expect(m.hitRate).toBe(0)
    expect(m.warmUpCount).toBe(0)
    expect(m.resetCount).toBe(0)
    expect(m.compactionEvents).toBe(0)
    expect(m.compactionInputTokens).toBe(0)
    expect(m.resetWriteTokens).toBe(0)
    expect(m.compressionEquivalenceRounds).toBe(0)
  })

  it('classifies the first fresh-session request as warm-up', async () => {
    const { ctx, session } = await harness()
    appendHeader(session, 'initial')
    appendAssistant(session, 1, 1, { inputTokens: 100, outputTokens: 50 })
    const m = projected(ctx, session)
    expect(m.warmUpCount).toBe(1)
    expect(m.mainChainRequests).toBe(0)
    expect(m.resetCount).toBe(0) // initial request is not a "reset event"
  })

  it('counts sub-sequent requests as main-chain and computes hit rate', async () => {
    const { ctx, session } = await harness()
    appendHeader(session, 'initial')
    appendAssistant(session, 1, 1, { inputTokens: 100, outputTokens: 50 })
    // Second request: no reset, no warm-up
    appendHeader(session, 'resume')
    appendAssistant(session, 2, 1, { inputTokens: 80, cacheReadTokens: 70, outputTokens: 30 })
    const m = projected(ctx, session)
    expect(m.warmUpCount).toBe(1)
    expect(m.mainChainRequests).toBe(1)
    expect(m.mainChainHits).toBe(1)
    expect(m.hitRate).toBe(1)
  })

  it('counts a miss when cacheReadTokens is 0', async () => {
    const { ctx, session } = await harness()
    appendHeader(session, 'initial')
    appendAssistant(session, 1, 1, { inputTokens: 100, outputTokens: 50 })
    appendHeader(session, 'resume')
    appendAssistant(session, 2, 1, { inputTokens: 80, cacheReadTokens: 0, outputTokens: 30 })
    const m = projected(ctx, session)
    expect(m.mainChainRequests).toBe(1)
    expect(m.mainChainHits).toBe(0)
    expect(m.hitRate).toBe(0)
  })

  it('treats a compaction/start as a reset: next request is warm-up', async () => {
    const { ctx, session } = await harness()
    appendHeader(session, 'initial')
    appendAssistant(session, 1, 1, { inputTokens: 100, outputTokens: 50 })
    // Compaction followed by a request
    appendHeader(session, 'resume')
    session.append('compaction/start', { compactionId: CompactionId('c1'), turn: null })
    session.append('compaction/end', { compactionId: CompactionId('c1'), turn: null })
    appendAssistant(session, 2, 1, { inputTokens: 60, outputTokens: 20 })
    const m = projected(ctx, session)
    expect(m.resetCount).toBe(1)
    expect(m.warmUpCount).toBe(2) // first request + after-compaction
    expect(m.mainChainRequests).toBe(0)
  })

  it('treats a reason=change header as a reset', async () => {
    const { ctx, session } = await harness()
    appendHeader(session, 'initial')
    appendAssistant(session, 1, 1, { inputTokens: 100, outputTokens: 50 })
    appendHeader(session, 'change', { provider: 'new-provider', model: 'new-model' })
    appendAssistant(session, 2, 1, { inputTokens: 60, outputTokens: 20 })
    const m = projected(ctx, session)
    expect(m.resetCount).toBe(1)
    expect(m.warmUpCount).toBe(2)
    expect(m.mainChainRequests).toBe(0)
  })

  it('treats provider/model switch as a reset even without reason=change', async () => {
    const { ctx, session } = await harness()
    appendHeader(session, 'initial')
    appendAssistant(session, 1, 1, { inputTokens: 100, outputTokens: 50 })
    // Different model, same reason 'resume' — should still count as a reset
    appendHeader(session, 'resume', { provider: 'different', model: 'different-model' })
    appendAssistant(session, 2, 1, { inputTokens: 60, outputTokens: 20 })
    const m = projected(ctx, session)
    expect(m.resetCount).toBe(1)
    expect(m.warmUpCount).toBe(2)
  })

  it('aggregates compaction/summary tokens into the ledger but does not double-count resets', async () => {
    const { ctx, session } = await harness()
    appendHeader(session, 'initial')
    appendAssistant(session, 1, 1, { inputTokens: 1000, outputTokens: 500 }) // warm-up
    // One main-chain request to establish the average round increment.
    appendHeader(session, 'resume')
    appendAssistant(session, 2, 1, { inputTokens: 1000, outputTokens: 500 }) // main-chain
    // Compaction start + summary + end
    appendHeader(session, 'resume')
    session.append('compaction/start', { compactionId: CompactionId('c1'), turn: null })
    appendCompactionSummary(session, 4000)
    session.append('compaction/end', { compactionId: CompactionId('c1'), turn: null })
    // A post-compaction warm-up request
    appendAssistant(session, 3, 1, { inputTokens: 200, outputTokens: 50 }) // warm-up
    const m = projected(ctx, session)
    expect(m.resetCount).toBe(1)
    expect(m.compactionEvents).toBe(1)
    expect(m.compactionInputTokens).toBe(4000)
    // avgMainInput = 1000 / 1 = 1000; equivalenceRounds = 4000 / 1000 = 4
    expect(m.compressionEquivalenceRounds).toBe(4)
  })

  it('compression equivalence within budget: small compaction relative to total rounds', async () => {
    const { ctx, session } = await harness()
    appendHeader(session, 'initial')
    appendAssistant(session, 1, 1, { inputTokens: 1000, outputTokens: 500 })
    appendHeader(session, 'resume')
    // Main-chain rounds
    appendAssistant(session, 2, 1, { inputTokens: 1000, outputTokens: 500 })
    const mBefore = projected(ctx, session)
    // Hit rate already computed; no compaction yet
    expect(mBefore.compressionEquivalenceRounds).toBe(0)
    expect(compressionEquivalenceWithinBudget(mBefore)).toBe(true)
  })

  it('exposes SLO targets from the budget r_min value', () => {
    // 32k window: r_min = 82.5% → SLO = min(90%, 82.5% + 2%) = 84.5%
    expect(sloTarget(0.825)).toBeCloseTo(0.845, 3)
    // 1M cap64k: r_min = 92.8% → SLO = min(90%, 92.8% + 2%) = 90%
    expect(sloTarget(0.928)).toBe(0.90)
  })

  it('folds reset-event write costs into the ledger without mutating the input', () => {
    const init = cacheMetricsProjectionDefinition.init()
    const next = foldResetWriteCost(init, 1250)
    expect(next.resetWriteTokens).toBe(1250)
    // Input state is untouched (pure transition, persistable snapshot).
    expect(init.resetWriteTokens).toBe(0)
    const folded = foldResetWriteCost(next, 2000)
    expect(folded.resetWriteTokens).toBe(3250)
  })

  it('ignores non-finite, negative, and zero reset-write costs', () => {
    const init = cacheMetricsProjectionDefinition.init()
    expect(foldResetWriteCost(init, Number.NaN)).toBe(init)
    expect(foldResetWriteCost(init, -10)).toBe(init)
    expect(foldResetWriteCost(init, 0)).toBe(init)
    expect(foldResetWriteCost(init, 0.4)).toBe(init) // rounds to 0
  })

  it('rounds fractional reset-write costs', () => {
    const init = cacheMetricsProjectionDefinition.init()
    expect(foldResetWriteCost(init, 1234.5).resetWriteTokens).toBe(1235)
  })

  it('handles multiple resets and warm-up rounds correctly', async () => {
    const { ctx, session } = await harness()
    appendHeader(session, 'initial')
    appendAssistant(session, 1, 1, { inputTokens: 100, outputTokens: 50 }) // warm-up
    appendHeader(session, 'resume')
    appendAssistant(session, 2, 1, { inputTokens: 80, cacheReadTokens: 60, outputTokens: 30 }) // main-chain hit
    appendHeader(session, 'resume')
    appendAssistant(session, 3, 1, { inputTokens: 90, cacheReadTokens: 70, outputTokens: 20 }) // main-chain hit
    // Reset: model change
    appendHeader(session, 'change', { provider: 'p2', model: 'm2' })
    appendAssistant(session, 4, 1, { inputTokens: 50, outputTokens: 10 }) // warm-up
    appendHeader(session, 'resume', { provider: 'p2', model: 'm2' })
    appendAssistant(session, 5, 1, { inputTokens: 60, cacheReadTokens: 40, outputTokens: 15 }) // main-chain hit
    const m = projected(ctx, session)
    expect(m.resetCount).toBe(1)
    expect(m.warmUpCount).toBe(2)
    expect(m.mainChainRequests).toBe(3)
    expect(m.mainChainHits).toBe(3)
    expect(m.hitRate).toBe(1)
  })
})
