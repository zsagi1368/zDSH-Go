/**
 * L0 cache-metrics projection: hit-rate domain, warm-up/one-shot exemption,
 * reset accounting, and the compression-equivalence ledger
 * (§2 L0, CONTEXT-CACHE-MANAGEMENT.md v2.3).
 *
 * Hit rate `r` is computed only on **main-chain requests** — requests that are
 * neither a warm-up round (the first request after a registered reset event)
 * nor a one-shot request. Warm-up and reset frequencies are exposed separately
 * for observability, per S1′: "重置频率与 warm-up 计数单独展示".
 *
 * Compression equivalence (S2′) is the design's own acceptance yardstick:
 *   压缩当量 = Σ 每次压缩的摘要输入 / 平均轮增量
 * and the acceptance rule is `压缩当量 ≤ 总轮数 × 20%`.
 *
 * @module @deepseek-ai/dsh-token-meter/cache-metrics
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * The `cache/ledger` session event is authored by the agent loop
 * (`@deepseek-ai/dsh-core/agent-loop`) but consumed here to rebuild the
 * authoritative reset-write Σ from the log. Under project-references builds
 * token-meter compiles without agent-loop in its program, so the augmentation
 * is re-declared here with the identical payload shape; interface merging
 * collapses the two declarations into one when a consumer sees both.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'cache/ledger': {
      ledger: string
      resetWriteCost: number
    }
  }
}

/**
 * Hit-rate and compaction metrics for one session.
 *
 * The hit rate `r` is computed only on main-chain requests: requests that are
 * neither warm-up (first request after a reset event) nor one-shot (a request
 * that carries a fresh session id and can never reuse a cache prefix). Warm-up
 * and one-shot counts are tracked separately for observability.
 */
export interface CacheMetricsProjection {
  /** Main-chain requests (eligible for hit-rate calculation). */
  readonly mainChainRequests: number
  /** Main-chain requests that received a cache hit (cacheReadTokens > 0). */
  readonly mainChainHits: number
  /** Steady-state main-chain hit rate; 0 when no eligible request was observed. */
  readonly hitRate: number
  /** Warm-up requests excluded from hit-rate (first request after each reset). */
  readonly warmUpCount: number
  /** One-shot requests excluded from hit-rate (fresh sessionId, disposable). */
  readonly oneShotCount: number
  /** Registered reset events (compaction, model change, session recovery, seed boundary). */
  readonly resetCount: number
  /** Compaction events recorded in the ledger. */
  readonly compactionEvents: number
  /** Accumulated compaction input tokens (Σ 摘要输入). */
  readonly compactionInputTokens: number
  /**
   * Accumulated cache-write cost from registered reset events (Σ η×context,
   * cost equation §0 second term). This is the single authoritative ledger:
   * it is rebuilt purely from the session's `cache/ledger` events, each of
   * which carries one reset's incremental cost folded in via
   * {@link foldResetWriteCost} (fed by the cache-guardian's
   * `accountResetCost`). The agent-loop's `totalResetWriteCost` is the same
   * Σ over the same events, so the two views agree live and after resume.
   */
  readonly resetWriteTokens: number
  /**
   * Compression equivalence in rounds: Σ 摘要输入 divided by the average
   * main-chain round input. Acceptance: ratio ≤ 0.20 of total rounds.
   */
  readonly compressionEquivalenceRounds: number
  /** The current SLO target for this window, when set by a consumer. */
  readonly slo?: number
  /** The SLO window (context window W), when set by a consumer. */
  readonly sloWindow?: number
}

/** Pre-declared module augmentation for the projection registry. */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Cache hit-rate and compaction metrics. */
    cacheMetrics: CacheMetricsProjection
  }
  interface SessionProjectionStateMap {
    cacheMetrics: CacheMetricsState
  }
}

const cacheMetricsSchema = z.object({
  mainChainRequests: z.number().int().nonnegative(),
  mainChainHits: z.number().int().nonnegative(),
  warmUpCount: z.number().int().nonnegative(),
  oneShotCount: z.number().int().nonnegative(),
  resetCount: z.number().int().nonnegative(),
  compactionEvents: z.number().int().nonnegative(),
  compactionInputTokens: z.number().int().nonnegative(),
  resetWriteTokens: z.number().int().nonnegative(),
  totalMainInputTokens: z.number().int().nonnegative(),
  pendingWarmUp: z.boolean(),
  lastModelKey: z.string().nullable(),
}).strict()

/** Internal ledger state of the cache-metrics projection. */
export type CacheMetricsState = z.infer<typeof cacheMetricsSchema>

/** Client-view schema; the transform drops absent optional keys so the
 * `exactOptionalPropertyTypes` build accepts the projection type. */
const cacheMetricsViewSchema: z.ZodType<CacheMetricsProjection> = z.object({
  mainChainRequests: z.number().int().nonnegative(),
  mainChainHits: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1),
  warmUpCount: z.number().int().nonnegative(),
  oneShotCount: z.number().int().nonnegative(),
  resetCount: z.number().int().nonnegative(),
  compactionEvents: z.number().int().nonnegative(),
  compactionInputTokens: z.number().int().nonnegative(),
  resetWriteTokens: z.number().int().nonnegative(),
  compressionEquivalenceRounds: z.number().nonnegative(),
  slo: z.number().min(0).max(1).optional(),
  sloWindow: z.number().int().positive().optional(),
}).strict().transform(({ slo, sloWindow, ...required }) => ({
  ...required,
  ...slo === undefined ? {} : { slo },
  ...sloWindow === undefined ? {} : { sloWindow },
}))

/** Whether a committed event registers a prefix-reset (warm-up cycle start). */
function isStructuralReset(event: SessionEvent): boolean {
  return event.type === 'compaction/start'
    || event.type === 'compaction/end'
    || event.type === 'session/end-seed'
}

/**
 * Cache-metrics projection definition.
 *
 * Tracks:
 * - Main-chain hit rate (warm-up/one-shot exempt)
 * - Reset frequency and warm-up rounds separately (S1′)
 * - Compression equivalence (压缩当量 ledger, S2′)
 *
 * Reset events set the pending-warm-up latch; the next request carrying usage
 * is classified as a warm-up round and excluded from the hit-rate domain.
 * A `request/header` whose provider/model differs from the previous one is a
 * reset even without an explicit `change` reason.
 */
export const cacheMetricsProjectionDefinition = {
  key: 'cacheMetrics',
  stateVersion: 1,
  stateSchema: cacheMetricsSchema,
  init: (): CacheMetricsState => ({
    mainChainRequests: 0,
    mainChainHits: 0,
    warmUpCount: 0,
    oneShotCount: 0,
    resetCount: 0,
    compactionEvents: 0,
    compactionInputTokens: 0,
    resetWriteTokens: 0,
    totalMainInputTokens: 0,
    pendingWarmUp: false,
    lastModelKey: null,
  }),
  apply: (state, event) => {
    // Structural resets arm the warm-up latch and never carry a route change.
    if (isStructuralReset(event)) {
      if (state.pendingWarmUp) return state
      return { ...state, resetCount: state.resetCount + 1, pendingWarmUp: true }
    }

    // L5 reset-write cost: each `cache/ledger` event carries ONE reset's
    // incremental cost (`η×contextTokens`, computed by the cache-guardian's
    // `accountResetCost` in the agent loop). Folding it here makes the
    // projection the single authoritative Σ-ledger, rebuilt purely from the
    // event log — the same sum the agent loop restores into
    // `totalResetWriteCost`, so the reported metric and the persisted ledger
    // can never diverge. This is cost accounting only: it does NOT re-arm the
    // warm-up latch or count a reset (the underlying compaction/tailMerge
    // reset is already accounted by its own structural/header event).
    if (event.type === 'cache/ledger') {
      return foldResetWriteCost(state, event.data.resetWriteCost)
    }

    // Request headers track the current provider/model route; a change (or an
    // explicit `change` reason) is a prefix reset that arms the warm-up latch.
    // A fresh-session `initial` request arms the latch too — nothing is cached
    // yet, so its first round can never hit — without counting as a reset.
    if (event.type === 'request/header') {
      const config = event.data.header.config
      const key = config.provider.length === 0
        ? null
        : `${config.provider}/${config.model}`
      if (event.data.reason === 'initial') {
        return {
          ...state,
          pendingWarmUp: true,
          ...key === null ? {} : { lastModelKey: key },
        }
      }
      const modelSwitched = state.lastModelKey !== null && key !== null && key !== state.lastModelKey
      if (event.data.reason === 'change' || modelSwitched) {
        return {
          ...state,
          resetCount: state.resetCount + 1,
          pendingWarmUp: true,
          ...key === null ? {} : { lastModelKey: key },
        }
      }
      // Route bookkeeping only: remember the newest route for later comparison.
      if (key !== null && key !== state.lastModelKey) {
        return { ...state, lastModelKey: key }
      }
      return state
    }

    // Compaction events join the compression-equivalence ledger. They are
    // already covered by the reset latch via compaction/start, so this is the
    // ledger half only.
    if (event.type === 'compaction/summary') {
      const shadowed = event.data.shadowedTokenCount
      if (shadowed === 0) return state
      return {
        ...state,
        compactionEvents: state.compactionEvents + 1,
        compactionInputTokens: state.compactionInputTokens + shadowed,
      }
    }

    // Classify a usage-bearing assistant message into the hit-rate domain.
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      const usage = event.data.usage
      if (state.pendingWarmUp) {
        return { ...state, warmUpCount: state.warmUpCount + 1, pendingWarmUp: false }
      }
      const cacheRead = usage.cacheReadTokens ?? 0
      return {
        ...state,
        mainChainRequests: state.mainChainRequests + 1,
        mainChainHits: state.mainChainHits + (cacheRead > 0 ? 1 : 0),
        totalMainInputTokens: state.totalMainInputTokens + usage.inputTokens,
      }
    }

    return state
  },
  wire: {
    viewSchema: cacheMetricsViewSchema,
    view: (state: CacheMetricsState): CacheMetricsProjection => {
      const avgMainInput = state.mainChainRequests === 0
        ? 0
        : state.totalMainInputTokens / state.mainChainRequests
      const equivalenceRounds = avgMainInput === 0
        ? 0
        : state.compactionInputTokens / avgMainInput
      return {
        mainChainRequests: state.mainChainRequests,
        mainChainHits: state.mainChainHits,
        hitRate: state.mainChainRequests === 0
          ? 0
          : state.mainChainHits / state.mainChainRequests,
        warmUpCount: state.warmUpCount,
        oneShotCount: state.oneShotCount,
        resetCount: state.resetCount,
        compactionEvents: state.compactionEvents,
        compactionInputTokens: state.compactionInputTokens,
        resetWriteTokens: state.resetWriteTokens,
        compressionEquivalenceRounds: equivalenceRounds,
      }
    },
  },
} satisfies ProjectionDefinition<'cacheMetrics', CacheMetricsState>

/**
 * Whether the compression-equivalence acceptance rule holds:
 * 压缩当量 (in rounds) ≤ 总轮数 × 20% (S2′).
 * @param metrics - cache-metrics projection.
 * @returns true when the equivalence ledger is within 20% of total rounds.
 */
export function compressionEquivalenceWithinBudget(metrics: CacheMetricsProjection): boolean {
  const totalRounds = metrics.mainChainRequests + metrics.warmUpCount + metrics.oneShotCount
  if (totalRounds === 0) return true
  return metrics.compressionEquivalenceRounds <= totalRounds * 0.20
}

/**
 * Effective steady-state hit rate `r` from a cache-metrics projection.
 * Returns 0 when no eligible request has been observed.
 */
export function effectiveHitRate(metrics: CacheMetricsProjection): number {
  return metrics.hitRate
}

/**
 * Per-window SLO target (S1′): `min(0.90, r_min + 2pp)`.
 * The consumer supplies `rMin` from the budget table (§1.3).
 * @param rMin - the r_min bound for the window (fraction).
 * @returns the SLO target for that window.
 */
export function sloTarget(rMin: number): number {
  return Math.min(0.90, rMin + 0.02)
}

/**
 * Fold one reset-event cache-write cost into the projection ledger.
 *
 * This is the token-meter half of the L5 cache-guardian integration
 * (CONTEXT-CACHE-MANAGEMENT.md §2 L5 "重置事件记账"): the guardian's
 * `accountResetCost(contextTokens, η)` computes `η×contextTokens`, and the
 * consuming layer folds it here so the projected `resetWriteTokens` keeps
 * accumulating the cost equation §0 second term `Σ w·η`.
 *
 * Pure transition (same convention as `apply`): returns a new state and
 * leaves the input untouched.
 * @param state - the current projection state.
 * @param cost - the reset write cost (token equivalent) to accumulate.
 * @returns the next state with `resetWriteTokens` increased by `cost`.
 */
export function foldResetWriteCost(state: CacheMetricsState, cost: number): CacheMetricsState {
  const rounded = Math.round(cost)
  if (!Number.isFinite(rounded) || rounded < 0) return state
  if (rounded === 0) return state
  return { ...state, resetWriteTokens: state.resetWriteTokens + rounded }
}
