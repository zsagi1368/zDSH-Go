/**
 * Configuration vocabulary for the replay-aware basic compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic/types
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Compact at this fraction of the model's context window. Defaults to `0.8`. */
  thresholdRatio?: number
  /**
   * Use the proactive L4 trigger line `W − R_pess` instead of
   * `thresholdRatio × W` (CONTEXT-CACHE-MANAGEMENT.md §1.2/§2 L4). Defaults to
   * `false` so the legacy ratio mode stays the fallback; when enabled it is the
   * recommended trigger. Below the legal domain (`W < 32768`) it falls back to
   * `thresholdRatio` mode with a warning.
   */
  proactiveTrigger?: boolean
  /** Parallel tool-result batch cap (BATCH_CAP) for the proactive trigger. Defaults to `2`. */
  batchCap?: number
  /** Max output hard cap (C) of the model, used by the proactive trigger. Defaults to `32768`. */
  outputCap?: number
  /** Recent context retained as a fraction of the model's window. Defaults to `0.16`. */
  retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
  retainTokens?: number
  /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to `8192`. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum retries after canonical context overflow; `0` disables recovery. Defaults to `1`. */
  maxOverflowRetries?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}

/** Basic compaction configuration with an optional exact-target policy table. */
export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelCompactPolicyConfig[]
  /** Enable automatic step-boundary pressure and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
}

/** Exactly one validated retention form. */
export type ResolvedRetention =
  | { readonly retainRatio: number; readonly retainTokens?: never }
  | { readonly retainRatio?: never; readonly retainTokens: number }

/** Validated policy fields shared before and after exact-target matching. */
interface ResolvedPolicyFields {
  readonly thresholdRatio: number
  readonly proactiveTrigger: boolean
  readonly batchCap: number
  readonly outputCap: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
}

/** Validated immutable config whose target-specific defaults remain unresolved. */
export type ResolvedConfig = ResolvedPolicyFields & ResolvedRetention & {
  readonly modelPolicies: readonly Readonly<ModelCompactPolicyConfig>[]
  readonly auto: boolean
}

/** Fully merged policy for one routed conversation target, before capacity scaling. */
export type ResolvedTargetPolicy = ResolvedPolicyFields & ResolvedRetention & {
  readonly target: Pick<LlmCallConfig, 'provider' | 'model'>
}

/** One routed model's concrete pressure and retention budget. */
export type ResolvedCompactSpec = Omit<ResolvedTargetPolicy, 'retainRatio' | 'retainTokens'> & {
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly retainTokens: number
  /**
   * R_pess of the proactive trigger (`maxTokens + batchCap×toolCap + 4096`);
   * present only when the proactive mode is actually in effect.
   */
  readonly rPess?: number
  /**
   * Non-empty only when a requested proactive trigger fell back to
   * `thresholdRatio` mode because the window is below the legal domain.
   */
  readonly warning?: string
}
