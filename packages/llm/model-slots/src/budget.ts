/**
 * Context-cache budget formulas (§1, CONTEXT-CACHE-MANAGEMENT.md v2.3).
 *
 * Single authoritative TypeScript implementation mirroring the v3 formulas
 * from `tools/budget_table.py`. Every public function is a pure computation
 * that matches the Python reference character-for-character.
 *
 * @module @deepseek-ai/dsh-model-slots/budget
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** Default parallel tool-result batch cap. */
export const BATCH_CAP = 2

/** Minimum legal window for context-cache management. */
export const MIN_WINDOW = 32768

/** Minimum output cap. */
export const MIN_OUTPUT_CAP = 1024

/** Default output cap when Profile C is missing or NaN. */
export const DEFAULT_OUTPUT_CAP = 32768

// ── Types ───────────────────────────────────────────────────────────────────

/** Model profile presented to the budget system. */
export interface Profile {
  /** Context window in tokens (W). */
  readonly window: number
  /** Max output hard cap (C); absent/NaN → DEFAULT_OUTPUT_CAP. */
  readonly outputCap?: number
}

/** A complete row of the budget table. */
export interface BudgetRow {
  /** Context window (W). */
  readonly window: number
  /** Output cap (C). */
  readonly outputCap: number
  /** maxTokens = min(C, floor(W × 0.10)). */
  readonly maxTokens: number
  /** reserve = ceil(maxTokens × 1.25) + 4096. */
  readonly reserve: number
  /** toolCap = max(1024, floor(0.25 × (reserve - maxTokens))). */
  readonly toolCap: number
  /** R_pess = maxTokens + BATCH_CAP × toolCap + 4096. */
  readonly rPess: number
  /** trigger = W - R_pess. */
  readonly trigger: number
  /** trigger / W as fraction. */
  readonly triggerRatio: number
  /** keepRecent = min(max(floor(W × 0.12), min(20000, floor(W × 0.30))), floor(0.8 × trigger)). */
  readonly keepRecent: number
  /** summaryInputMax = trigger - keepRecent (0 if negative). */
  readonly summaryInputMax: number
  /** summaryOutput = min(C, maxTokens, floor(0.8 × reserve), max(8192, floor(W × 0.01))). */
  readonly summaryOutput: number
  /** subagentReturn = max(2048, floor(0.25 × (reserve - maxTokens))). */
  readonly subagentReturn: number
  /** injectionBudget = max(4096, floor(W × 0.005)). */
  readonly injectionBudget: number
  /** deltaCap = max(8192, floor(W × 0.008)). */
  readonly deltaCap: number
  /** r_min = 1 - (maxTokens + BATCH_CAP × toolCap) / W. */
  readonly rMin: number
  /** SLO = min(0.90, r_min + 0.02). */
  readonly slo: number
}

/** Validation outcome for a Profile. */
export interface ProfileValidation {
  readonly valid: boolean
  readonly window: number
  readonly outputCap: number
  readonly message?: string
}

// ── Pure formula functions ──────────────────────────────────────────────────

/** maxTokens = min(C, floor(W × 0.10)). */
export function computeMaxTokens(w: number, cap: number): number {
  return Math.min(cap, Math.floor(w * 0.10))
}

/** reserve = ceil(maxTokens × 1.25) + 4096. */
export function computeReserve(maxTokens: number): number {
  return Math.ceil(maxTokens * 1.25) + 4096
}

/** toolCap = max(1024, floor(0.25 × (reserve - maxTokens))). */
export function computeToolCap(maxTokens: number, reserve: number): number {
  return Math.max(1024, Math.floor(0.25 * (reserve - maxTokens)))
}

/** R_pess = maxTokens + BATCH_CAP × toolCap + 4096. */
export function computeRPess(maxTokens: number, toolCap: number, batchCap: number = BATCH_CAP): number {
  return maxTokens + batchCap * toolCap + 4096
}

/** trigger = W - R_pess. */
export function computeTrigger(w: number, rPess: number): number {
  return w - rPess
}

/** keepRecent = min(max(floor(W × 0.12), min(20000, floor(W × 0.30))), floor(0.8 × trigger)). */
export function computeKeepRecent(w: number, trigger: number): number {
  const floor12 = Math.floor(w * 0.12)
  const floor30 = Math.floor(w * 0.30)
  const min30 = Math.min(20000, floor30)
  const lower = Math.max(floor12, min30)
  return Math.min(lower, Math.floor(0.8 * trigger))
}

/** summaryInputMax = max(0, trigger - keepRecent). */
export function computeSummaryInputMax(trigger: number, keepRecent: number): number {
  return Math.max(0, trigger - keepRecent)
}

/** summaryOutput = min(C, maxTokens, floor(0.8 × reserve), max(8192, floor(W × 0.01))). */
export function computeSummaryOutput(w: number, cap: number, maxTokens: number, reserve: number): number {
  const capSum = Math.max(8192, Math.floor(w * 0.01))
  return Math.min(cap, maxTokens, Math.floor(0.8 * reserve), capSum)
}

/** subagentReturn = max(2048, floor(0.25 × (reserve - maxTokens))). */
export function computeSubagentReturn(maxTokens: number, reserve: number): number {
  return Math.max(2048, Math.floor(0.25 * (reserve - maxTokens)))
}

/** injectionBudget = max(4096, floor(W × 0.005)). */
export function computeInjectionBudget(w: number): number {
  return Math.max(4096, Math.floor(w * 0.005))
}

/** deltaCap = max(8192, floor(W × 0.008)). */
export function computeDeltaCap(w: number): number {
  return Math.max(8192, Math.floor(w * 0.008))
}

/** r_min = 1 - (maxTokens + BATCH_CAP × toolCap) / W. */
export function computeRMin(w: number, maxTokens: number, toolCap: number, batchCap: number = BATCH_CAP): number {
  return 1 - (maxTokens + batchCap * toolCap) / w
}

/** SLO = min(0.90, r_min + 2pp). */
export function computeSlo(rMin: number): number {
  return Math.min(0.90, rMin + 0.02)
}

// ── Composite computation ───────────────────────────────────────────────────

/**
 * Compute the full budget row for a profile.
 * @param w - context window (W).
 * @param cap - output cap (C).
 * @param batchCap - parallel tool batch cap (default BATCH_CAP).
 * @returns the complete BudgetRow.
 */
export function computeBudget(w: number, cap: number, batchCap: number = BATCH_CAP): BudgetRow {
  const maxTokens = computeMaxTokens(w, cap)
  const reserve = computeReserve(maxTokens)
  const toolCap = computeToolCap(maxTokens, reserve)
  const rPess = computeRPess(maxTokens, toolCap, batchCap)
  const trigger = computeTrigger(w, rPess)
  const keepRecent = computeKeepRecent(w, trigger)
  const summaryInputMax = computeSummaryInputMax(trigger, keepRecent)
  const summaryOutput = computeSummaryOutput(w, cap, maxTokens, reserve)
  const subagentReturn = computeSubagentReturn(maxTokens, reserve)
  const injectionBudget = computeInjectionBudget(w)
  const deltaCap = computeDeltaCap(w)
  const rMin = computeRMin(w, maxTokens, toolCap, batchCap)
  const slo = computeSlo(rMin)

  return {
    window: w,
    outputCap: cap,
    maxTokens,
    reserve,
    toolCap,
    rPess,
    trigger,
    triggerRatio: trigger / w,
    keepRecent,
    summaryInputMax,
    summaryOutput,
    subagentReturn,
    injectionBudget,
    deltaCap,
    rMin,
    slo,
  }
}

// ── Profile validation ──────────────────────────────────────────────────────

/**
 * Validate a model profile against the budget rules (§1.1).
 *
 * Rules:
 *  1. W ≥ 32768 and C ≥ 1024 (W < 32768 → reject).
 *  2. maxTokens = min(C, floor(W × 0.10)) — 10% hard constraint.
 *  3. R_pess < W (otherwise reject the model combination).
 *
 * @param profile - the profile to validate.
 * @returns validation outcome with resolved window/cap and optional message.
 */
export function validateProfile(profile: Profile): ProfileValidation {
  const w = profile.window
  const rawCap = profile.outputCap

  // Resolve cap: NaN or missing → DEFAULT_OUTPUT_CAP.
  const cap = (rawCap !== undefined && Number.isFinite(rawCap) && rawCap > 0)
    ? rawCap
    : DEFAULT_OUTPUT_CAP

  // Rule 1: W ≥ 32768
  if (w < MIN_WINDOW) {
    return {
      valid: false,
      window: w,
      outputCap: cap,
      message: `Window ${w} is below minimum ${MIN_WINDOW} (16k domain rejected: r_min=76% and compression storm)`,
    }
  }

  // Rule 1: C ≥ 1024
  if (cap < MIN_OUTPUT_CAP) {
    return {
      valid: false,
      window: w,
      outputCap: cap,
      message: `Output cap ${cap} is below minimum ${MIN_OUTPUT_CAP}`,
    }
  }

  // Rule 2: 10% hard constraint is enforced by construction — maxTokens is
  // always min(C, floor(W × 0.10)); no combination can exceed it.
  const mt = computeMaxTokens(w, cap)

  // Rule 3: R_pess < W
  const rs = computeReserve(mt)
  const tc = computeToolCap(mt, rs)
  const rp = computeRPess(mt, tc)
  if (rp >= w) {
    return {
      valid: false,
      window: w,
      outputCap: cap,
      message: `R_pess (${rp}) >= W (${w}): this model combination cannot satisfy the pessimistic trigger guard`,
    }
  }

  return { valid: true, window: w, outputCap: cap }
}

// ── Lock table ──────────────────────────────────────────────────────────────

/** One locked row in the budget table for CI comparison. */
export interface LockedRow {
  readonly label: string
  readonly window: number
  readonly outputCap: number
  readonly maxTokens: number
  readonly reserve: number
  readonly toolCap: number
  readonly rPess: number
  readonly trigger: number
  readonly triggerPercent: number
  readonly keepRecent: number
  readonly summaryInputMax: number
  readonly summaryOutput: number
  readonly subagentReturn: number
  readonly rMin: number
}

/**
 * Locked 7-case budget table for CI verification (matches
 * `tools/budget_table.py` v3 output exactly).
 *
 * The 16k row is included as a reference but marked as rejected domain.
 */
export const BUDGET_TABLE: readonly LockedRow[] = [
  {
    label: '16k(拒绝域)',
    window: 16384, outputCap: 4096,
    maxTokens: 1638, reserve: 6144, toolCap: 1126, rPess: 7986,
    trigger: 8398, triggerPercent: 51.3, keepRecent: 4915,
    summaryInputMax: 3483, summaryOutput: 1638, subagentReturn: 2048,
    rMin: 76.3,
  },
  {
    label: '32k',
    window: 32768, outputCap: 8192,
    maxTokens: 3276, reserve: 8191, toolCap: 1228, rPess: 9828,
    trigger: 22940, triggerPercent: 70.0, keepRecent: 9830,
    summaryInputMax: 13110, summaryOutput: 3276, subagentReturn: 2048,
    rMin: 82.5,
  },
  {
    label: '64k',
    window: 65536, outputCap: 16384,
    maxTokens: 6553, reserve: 12288, toolCap: 1433, rPess: 13515,
    trigger: 52021, triggerPercent: 79.4, keepRecent: 19660,
    summaryInputMax: 32361, summaryOutput: 6553, subagentReturn: 2048,
    rMin: 85.6,
  },
  {
    label: '128k',
    window: 131072, outputCap: 32768,
    maxTokens: 13107, reserve: 20480, toolCap: 1843, rPess: 20889,
    trigger: 110183, triggerPercent: 84.1, keepRecent: 20000,
    summaryInputMax: 90183, summaryOutput: 8192, subagentReturn: 2048,
    rMin: 87.2,
  },
  {
    label: '200k',
    window: 204800, outputCap: 65536,
    maxTokens: 20480, reserve: 29696, toolCap: 2304, rPess: 29184,
    trigger: 175616, triggerPercent: 85.8, keepRecent: 24576,
    summaryInputMax: 151040, summaryOutput: 8192, subagentReturn: 2304,
    rMin: 87.8,
  },
  {
    label: '1M cap=64k',
    window: 1048576, outputCap: 65536,
    maxTokens: 65536, reserve: 86016, toolCap: 5120, rPess: 79872,
    trigger: 968704, triggerPercent: 92.4, keepRecent: 125829,
    summaryInputMax: 842875, summaryOutput: 10485, subagentReturn: 5120,
    rMin: 92.8,
  },
  {
    label: '1M cap=128k',
    window: 1048576, outputCap: 131072,
    maxTokens: 104857, reserve: 135168, toolCap: 7577, rPess: 124107,
    trigger: 924469, triggerPercent: 88.2, keepRecent: 125829,
    summaryInputMax: 798640, summaryOutput: 10485, subagentReturn: 7577,
    rMin: 88.6,
  },
]
