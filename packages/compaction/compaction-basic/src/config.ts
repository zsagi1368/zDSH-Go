/**
 * Load-time validation and routed-model policy resolution for compaction-basic.
 *
 * @module @deepseek-ai/dsh-compaction-basic/config
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import {
  BATCH_CAP,
  DEFAULT_OUTPUT_CAP,
  MIN_OUTPUT_CAP,
  MIN_WINDOW,
  computeBudget,
} from '@deepseek-ai/dsh-model-slots'
import type { BudgetRow } from '@deepseek-ai/dsh-model-slots'
import type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** Default request-pressure fraction for every routed model. */
const DEFAULT_THRESHOLD_RATIO = 0.8

/** Default verbatim-tail fraction for every routed model. */
const DEFAULT_RETAIN_RATIO = 0.16

/** Fields shared by top-level defaults and exact-target overrides. */
const POLICY_CONFIG_KEYS = [
  'thresholdRatio',
  'proactiveTrigger',
  'batchCap',
  'outputCap',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
] as const

/** Complete public top-level configuration key set. */
const BASIC_COMPACT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...POLICY_CONFIG_KEYS,
  'modelPolicies',
  'auto',
])

/** Complete exact-target override key set. */
const MODEL_POLICY_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  ...POLICY_CONFIG_KEYS,
])

/** Target-specific pressure configuration failure eligible for warning suppression. */
export class TargetPressureConfigError extends Error {
  /**
   * @param targetKey - exact provider/model route used as the warning key.
   * @param message - actionable configuration failure detail.
   */
  constructor(readonly targetKey: string, message: string) {
    super(message)
  }
}

/**
 * Resolve and validate service defaults plus exact-target partial overrides.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns detached immutable defaults and validated exact-target overrides.
 */
export function resolveConfig(config: BasicCompactionConfig = {}): ResolvedConfig {
  validateKeys(config, BASIC_COMPACT_CONFIG_KEYS, 'BasicCompactionConfig')
  validatePolicy(config, 'BasicCompactionConfig')
  if (config.auto !== undefined && typeof config.auto !== 'boolean') {
    throw new Error('BasicCompactionConfig: auto must be a boolean')
  }

  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  const retention = resolveRetention(config, { retainRatio: DEFAULT_RETAIN_RATIO })
  validateRatioRetention(thresholdRatio, retention, 'BasicCompactionConfig')
  const modelPolicies = resolveModelPolicies(config.modelPolicies)
  for (const [index, policy] of modelPolicies.entries()) {
    validateRatioRetention(
      policy.thresholdRatio ?? thresholdRatio,
      resolveRetention(policy, retention),
      `BasicCompactionConfig: modelPolicies[${index}]`,
    )
  }

  return deepFreeze({
    thresholdRatio,
    proactiveTrigger: config.proactiveTrigger ?? false,
    batchCap: config.batchCap ?? BATCH_CAP,
    outputCap: config.outputCap ?? DEFAULT_OUTPUT_CAP,
    ...retention,
    summarizationProvider: config.summarizationProvider ?? '',
    summarizationModel: config.summarizationModel ?? '',
    maxTokens: config.maxTokens ?? 8192,
    compactionRetries: config.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 1,
    modelPolicies,
    auto: config.auto ?? true,
  })
}

/**
 * Merge the exact provider/model override over the validated default policy.
 * @param config - validated service defaults and override table.
 * @param target - exact durable provider/model route to match.
 * @returns detached immutable policy before model-capacity scaling.
 */
export function resolveTargetPolicy(
  config: ResolvedConfig,
  target: Pick<LlmCallConfig, 'provider' | 'model'>,
): ResolvedTargetPolicy {
  const override = config.modelPolicies.find(policy => (
    policy.provider === target.provider && policy.model === target.model
  ))
  const inheritedRetention: ResolvedRetention = config.retainTokens === undefined
    ? { retainRatio: config.retainRatio }
    : { retainTokens: config.retainTokens }
  return deepFreeze({
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    proactiveTrigger: override?.proactiveTrigger ?? config.proactiveTrigger,
    batchCap: override?.batchCap ?? config.batchCap,
    outputCap: override?.outputCap ?? config.outputCap,
    ...resolveRetention(override ?? {}, inheritedRetention),
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
  })
}

/**
 * Scale one routed policy into concrete token budgets for its model capacity.
 * @param policy - merged policy for the exact routed target.
 * @param contextWindow - positive adapter-owned capacity for that target.
 * @returns detached immutable pressure and retention budgets.
 *
 * With `proactiveTrigger` the pressure line is the proactive L4 trigger
 * `W − R_pess` from `model-slots` `computeBudget` (CONTEXT-CACHE-MANAGEMENT.md
 * §1.2/§2 L4), replacing `thresholdRatio × W`. R_pess =
 * maxTokens + batchCap×toolCap + 4096, with maxTokens = min(C, floor(W×0.10)),
 * toolCap = max(1024, floor(0.25×(reserve−maxTokens))), reserve =
 * ceil(maxTokens×1.25)+4096 — formula-for-formula identical to
 * `scripts/budget-table.py` v3. The legal domain starts at W = 32768; a
 * window below it rejects the proactive mode and falls back to
 * `thresholdRatio` with a warning. `batchCap` (BATCH_CAP, default 2) is read
 * from configuration only: a session-level rolling observation of the largest
 * parallel tool batch may suggest raising it, but never rewrites it.
 */
export function resolveCompactSpec(
  policy: ResolvedTargetPolicy,
  contextWindow: number,
): ResolvedCompactSpec {
  const targetKey = `${policy.target.provider}/${policy.target.model}`
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`,
    )
  }
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(contextWindow * policy.retainRatio)
    : policy.retainTokens

  let proactiveTrigger = policy.proactiveTrigger
  let thresholdTokens: number
  let budget: BudgetRow | undefined
  let warning: string | undefined
  if (proactiveTrigger) {
    if (contextWindow < MIN_WINDOW) {
      // Legal-domain rejection (design §1.1: W < 32768 is the 16k reject domain).
      proactiveTrigger = false
      thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio)
      warning = `BasicCompactionConfig: ${targetKey} requested the proactive trigger `
        + `for window ${contextWindow} below the legal domain ${MIN_WINDOW}; fell back to `
        + 'thresholdRatio mode (16k domain rejected: r_min=76% and compression storm)'
    } else {
      budget = computeBudget(contextWindow, policy.outputCap, policy.batchCap)
      thresholdTokens = budget.trigger
    }
  } else {
    thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio)
  }

  if (retainTokens >= thresholdTokens) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: ${policy.target.provider}/${policy.target.model} retainTokens `
      + `(${retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
    )
  }
  return deepFreeze({
    target: { ...policy.target },
    contextWindow,
    thresholdRatio: policy.thresholdRatio,
    proactiveTrigger,
    batchCap: policy.batchCap,
    outputCap: policy.outputCap,
    thresholdTokens,
    retainTokens,
    summarizationProvider: policy.summarizationProvider,
    summarizationModel: policy.summarizationModel,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries,
    ...budget === undefined ? {} : { rPess: budget.rPess },
    ...warning === undefined ? {} : { warning },
  })
}

/** Choose an explicit retention form or inherit the already-resolved fallback. */
function resolveRetention(
  config: CompactionPolicyConfig,
  fallback: ResolvedRetention,
): ResolvedRetention {
  if (config.retainTokens !== undefined) return { retainTokens: config.retainTokens }
  if (config.retainRatio !== undefined) return { retainRatio: config.retainRatio }
  return fallback
}

/** Reject a capacity-independent retention conflict at plugin load. */
function validateRatioRetention(
  thresholdRatio: number,
  retention: ResolvedRetention,
  name: string,
): void {
  if (retention.retainRatio !== undefined && retention.retainRatio >= thresholdRatio) {
    throw new Error(
      `${name}: retainRatio (${retention.retainRatio}) must be less than `
      + `the resolved thresholdRatio (${thresholdRatio})`,
    )
  }
}

/** Validate, detach, and reject duplicate exact-target policies. */
function resolveModelPolicies(configured: unknown): ModelCompactPolicyConfig[] {
  if (configured === undefined) return []
  if (!Array.isArray(configured)) {
    throw new Error('BasicCompactionConfig: modelPolicies must be an array')
  }
  const seen = new Set<string>()
  return configured.map((source: unknown, index) => {
    const name = `BasicCompactionConfig: modelPolicies[${index}]`
    assertModelPolicy(source, name)
    const key = `${source.provider}\u0000${source.model}`
    if (seen.has(key)) {
      throw new Error(
        `BasicCompactionConfig: duplicate model policy for ${source.provider}/${source.model}`,
      )
    }
    seen.add(key)
    return { ...source }
  })
}

/** Validate one untrusted exact-target override and narrow its public type. */
function assertModelPolicy(
  source: unknown,
  name: string,
): asserts source is ModelCompactPolicyConfig {
  if (!isUnknownRecord(source)) throw new Error(`${name} must be an object`)
  validateKeys(source, MODEL_POLICY_KEYS, name)
  assertNonEmptyString(`${name}.provider`, source.provider)
  assertNonEmptyString(`${name}.model`, source.model)
  validatePolicy(source, name)
}

/** Validate the fields common to defaults and exact-target partial overrides. */
function validatePolicy(
  config: CompactionPolicyConfig | Record<string, unknown>,
  name: string,
): void {
  const thresholdRatio = config.thresholdRatio
  const proactiveTrigger = config.proactiveTrigger
  const batchCap = config.batchCap
  const outputCap = config.outputCap
  const retainRatio = config.retainRatio
  const retainTokens = config.retainTokens
  const maxTokens = config.maxTokens
  const compactionRetries = config.compactionRetries
  const maxOverflowRetries = config.maxOverflowRetries
  if (thresholdRatio !== undefined) assertRatio(`${name}.thresholdRatio`, thresholdRatio)
  if (proactiveTrigger !== undefined && typeof proactiveTrigger !== 'boolean') {
    throw new Error(`${name}.proactiveTrigger must be a boolean`)
  }
  if (batchCap !== undefined) assertPositiveInteger(`${name}.batchCap`, batchCap)
  if (outputCap !== undefined && (
    typeof outputCap !== 'number'
    || !Number.isInteger(outputCap)
    || outputCap < MIN_OUTPUT_CAP
  )) {
    throw new Error(
      `${name}.outputCap (${String(outputCap)}) must be an integer >= ${MIN_OUTPUT_CAP}`,
    )
  }
  if (retainRatio !== undefined) assertRatio(`${name}.retainRatio`, retainRatio)
  if (retainTokens !== undefined) assertNonNegativeInteger(`${name}.retainTokens`, retainTokens)
  if (retainRatio !== undefined && retainTokens !== undefined) {
    throw new Error(`${name}: retainRatio and retainTokens are mutually exclusive`)
  }
  if (maxTokens !== undefined) assertPositiveInteger(`${name}.maxTokens`, maxTokens)
  if (compactionRetries !== undefined) {
    assertNonNegativeInteger(`${name}.compactionRetries`, compactionRetries)
  }
  if (maxOverflowRetries !== undefined) {
    assertNonNegativeInteger(`${name}.maxOverflowRetries`, maxOverflowRetries)
  }

  validateSummarizationPair(config, name)
}

/** Require one scope to omit, clear, or replace the summarization target as a pair. */
function validateSummarizationPair(
  config: CompactionPolicyConfig | Record<string, unknown>,
  name: string,
): void {
  const provider = config.summarizationProvider
  const model = config.summarizationModel
  if (provider !== undefined && typeof provider !== 'string') {
    throw new Error(`${name}.summarizationProvider must be a string`)
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new Error(`${name}.summarizationModel must be a string`)
  }
  if (provider === undefined && model === undefined) return
  if (provider === undefined || model === undefined
    || (provider.length === 0) !== (model.length === 0)) {
    throw new Error(
      `${name}: summarizationProvider and summarizationModel must be set together `
      + 'as an empty or non-empty pair',
    )
  }
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateKeys(config: object, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`)
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} (${String(value)}) must be a non-negative integer`)
  }
}

function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`)
  }
}
