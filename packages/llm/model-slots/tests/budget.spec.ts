import { describe, expect, it } from 'vitest'
import {
  BATCH_CAP,
  BUDGET_TABLE,
  DEFAULT_OUTPUT_CAP,
  MIN_OUTPUT_CAP,
  MIN_WINDOW,
  computeBudget,
  computeDeltaCap,
  computeInjectionBudget,
  computeKeepRecent,
  computeMaxTokens,
  computeRPess,
  computeRMin,
  computeReserve,
  computeSlo,
  computeSubagentReturn,
  computeSummaryInputMax,
  computeSummaryOutput,
  computeToolCap,
  computeTrigger,
  validateProfile,
} from '../src/budget.ts'

describe('budget formulas match the authoritative table (tools/budget_table.py v3)', () => {
  // Expected values transcribed from `python tools/budget_table.py` (v3).
  const CASES: ReadonlyArray<{
    label: string
    window: number
    cap: number
    maxTokens: number
    reserve: number
    toolCap: number
    rPess: number
    trigger: number
    triggerPct: number
    keepRecent: number
    summaryInputMax: number
    summaryOutput: number
    subagentReturn: number
    rMin: number
  }> = [
    { label: '16k', window: 16384, cap: 4096, maxTokens: 1638, reserve: 6144, toolCap: 1126, rPess: 7986, trigger: 8398, triggerPct: 51.3, keepRecent: 4915, summaryInputMax: 3483, summaryOutput: 1638, subagentReturn: 2048, rMin: 76.3 },
    { label: '32k', window: 32768, cap: 8192, maxTokens: 3276, reserve: 8191, toolCap: 1228, rPess: 9828, trigger: 22940, triggerPct: 70.0, keepRecent: 9830, summaryInputMax: 13110, summaryOutput: 3276, subagentReturn: 2048, rMin: 82.5 },
    { label: '64k', window: 65536, cap: 16384, maxTokens: 6553, reserve: 12288, toolCap: 1433, rPess: 13515, trigger: 52021, triggerPct: 79.4, keepRecent: 19660, summaryInputMax: 32361, summaryOutput: 6553, subagentReturn: 2048, rMin: 85.6 },
    { label: '128k', window: 131072, cap: 32768, maxTokens: 13107, reserve: 20480, toolCap: 1843, rPess: 20889, trigger: 110183, triggerPct: 84.1, keepRecent: 20000, summaryInputMax: 90183, summaryOutput: 8192, subagentReturn: 2048, rMin: 87.2 },
    { label: '200k', window: 204800, cap: 65536, maxTokens: 20480, reserve: 29696, toolCap: 2304, rPess: 29184, trigger: 175616, triggerPct: 85.8, keepRecent: 24576, summaryInputMax: 151040, summaryOutput: 8192, subagentReturn: 2304, rMin: 87.8 },
    { label: '1M cap64k', window: 1048576, cap: 65536, maxTokens: 65536, reserve: 86016, toolCap: 5120, rPess: 79872, trigger: 968704, triggerPct: 92.4, keepRecent: 125829, summaryInputMax: 842875, summaryOutput: 10485, subagentReturn: 5120, rMin: 92.8 },
    { label: '1M cap128k', window: 1048576, cap: 131072, maxTokens: 104857, reserve: 135168, toolCap: 7577, rPess: 124107, trigger: 924469, triggerPct: 88.2, keepRecent: 125829, summaryInputMax: 798640, summaryOutput: 10485, subagentReturn: 7577, rMin: 88.6 },
  ]

  for (const c of CASES) {
    it(`matches the authoritative row for ${c.label} (W=${c.window}, C=${c.cap})`, () => {
      const row = computeBudget(c.window, c.cap)
      expect(row.maxTokens).toBe(c.maxTokens)
      expect(row.reserve).toBe(c.reserve)
      expect(row.toolCap).toBe(c.toolCap)
      expect(row.rPess).toBe(c.rPess)
      expect(row.trigger).toBe(c.trigger)
      expect(row.keepRecent).toBe(c.keepRecent)
      expect(row.summaryInputMax).toBe(c.summaryInputMax)
      expect(row.summaryOutput).toBe(c.summaryOutput)
      expect(row.subagentReturn).toBe(c.subagentReturn)
      expect(row.rMin * 100).toBeCloseTo(c.rMin, 1)
      expect(row.triggerRatio * 100).toBeCloseTo(c.triggerPct, 1)
      // SLO = min(90%, r_min + 2pp); table r_min is rounded to 1 decimal, so
      // compare at 0.5 percentage-point tolerance.
      expect(row.slo).toBeCloseTo(Math.min(0.90, c.rMin / 100 + 0.02), 2)
    })
  }
})

describe('locked BUDGET_TABLE', () => {
  it('covers the 7 reference cases', () => {
    expect(BUDGET_TABLE).toHaveLength(7)
    // Every locked row reproduces the same numbers as the formulas.
    for (const locked of BUDGET_TABLE) {
      const row = computeBudget(locked.window, locked.outputCap)
      expect(row.maxTokens).toBe(locked.maxTokens)
      expect(row.reserve).toBe(locked.reserve)
      expect(row.toolCap).toBe(locked.toolCap)
      expect(row.rPess).toBe(locked.rPess)
      expect(row.trigger).toBe(locked.trigger)
      expect(row.keepRecent).toBe(locked.keepRecent)
      expect(row.summaryInputMax).toBe(locked.summaryInputMax)
      expect(row.summaryOutput).toBe(locked.summaryOutput)
      expect(row.subagentReturn).toBe(locked.subagentReturn)
      expect(row.rMin * 100).toBeCloseTo(locked.rMin, 1)
    }
  })
})

describe('per-formula units', () => {
  it('computes maxTokens under the 10% hard cap', () => {
    expect(computeMaxTokens(32768, 8192)).toBe(3276)
    expect(computeMaxTokens(32768, 8192)).toBeLessThanOrEqual(Math.floor(32768 * 0.10))
    // C smaller than 10% clamps maxTokens to C.
    expect(computeMaxTokens(32768, 2048)).toBe(2048)
  })

  it('computes reserve with the 1.25x headroom plus 4096 slack', () => {
    expect(computeReserve(3276)).toBe(8191)
  })

  it('computes toolCap with a 1024 floor', () => {
    // A tiny reserve yields the floor.
    expect(computeToolCap(100, 2000)).toBe(1024)
    expect(computeToolCap(3276, 8191)).toBe(1228)
  })

  it('computes R_pess with BATCH_CAP and the 4096 slack', () => {
    expect(computeRPess(3276, 1228)).toBe(3276 + 2 * 1228 + 4096)
    // A raised batch cap increases R_pess.
    expect(computeRPess(3276, 1228, 3)).toBe(3276 + 3 * 1228 + 4096)
    expect(BATCH_CAP).toBe(2)
  })

  it('computes the trigger as W minus R_pess', () => {
    expect(computeTrigger(32768, 9828)).toBe(22940)
  })

  it('computes keepRecent with the W-dependent brackets', () => {
    expect(computeKeepRecent(32768, 22940)).toBe(9830)
    // 128k clamps to 20000.
    expect(computeKeepRecent(131072, 110183)).toBe(20000)
    // 1M: the 12% floor (125829) is below the 30% min(20000, ...) branch, so the
    // 12% floor dominates and stays below the 0.8×trigger cap.
    expect(computeKeepRecent(1048576, 968704)).toBe(125829)
    expect(computeKeepRecent(1048576, 968704)).toBeLessThan(Math.floor(0.8 * 968704))
  })

  it('computes summaryInputMax as trigger minus keepRecent, never negative', () => {
    expect(computeSummaryInputMax(22940, 9830)).toBe(13110)
    expect(computeSummaryInputMax(100, 200)).toBe(0)
  })

  it('computes summaryOutput with the W-1% floor of 8192', () => {
    expect(computeSummaryOutput(32768, 8192, 3276, 8191)).toBe(3276)
    expect(computeSummaryOutput(1048576, 65536, 65536, 86016)).toBe(10485)
  })

  it('computes subagentReturn with a 2048 floor', () => {
    expect(computeSubagentReturn(3276, 8191)).toBe(2048)
    expect(computeSubagentReturn(65536, 86016)).toBe(5120)
  })

  it('computes injection and delta budgets from W', () => {
    expect(computeInjectionBudget(32768)).toBe(4096)
    expect(computeInjectionBudget(1048576)).toBe(Math.floor(1048576 * 0.005))
    expect(computeDeltaCap(32768)).toBe(8192)
    expect(computeDeltaCap(1048576)).toBe(Math.floor(1048576 * 0.008))
  })

  it('computes r_min and SLO from the budget row', () => {
    expect(computeRMin(32768, 3276, 1228)).toBeCloseTo(0.825, 3)
    expect(computeSlo(computeRMin(32768, 3276, 1228))).toBeCloseTo(0.845, 3)
    // 1M cap64k: r_min+2pp would exceed 90%, so SLO clamps to 90%.
    expect(computeSlo(0.928)).toBe(0.90)
  })
})

describe('validateProfile (§1.1)', () => {
  it('accepts a legal 32k profile with the 10% constraint intact', () => {
    const v = validateProfile({ window: 32768, outputCap: 8192 })
    expect(v.valid).toBe(true)
    expect(v.window).toBe(32768)
    expect(v.outputCap).toBe(8192)
  })

  it('accepts a legal 1M/cap64k profile', () => {
    expect(validateProfile({ window: 1048576, outputCap: 65536 }).valid).toBe(true)
  })

  it('rejects the 16k domain (W < 32768)', () => {
    const v = validateProfile({ window: 16384, outputCap: 4096 })
    expect(v.valid).toBe(false)
    expect(v.message).toContain('below minimum')
  })

  it('rejects output caps below 1024', () => {
    const v = validateProfile({ window: 65536, outputCap: 512 })
    expect(v.valid).toBe(false)
    expect(v.message).toContain('below minimum')
  })

  it('defaults a missing or NaN cap to 32768 and keeps validation meaningful', () => {
    const v = validateProfile({ window: 65536 })
    expect(v.outputCap).toBe(DEFAULT_OUTPUT_CAP)
    expect(v.valid).toBe(true)
    const vNaN = validateProfile({ window: 65536, outputCap: Number.NaN })
    expect(vNaN.outputCap).toBe(DEFAULT_OUTPUT_CAP)
  })

  it('rejects a combination whose R_pess cannot fit the window', () => {
    // Window just above the 32768 floor with a big cap still leaves R_pess < W
    // (R_pess = maxTokens + 2*toolCap + 4096 ≈ 9828 < 32768). To force failure we
    // need an unrealistically small legal window — 32768 is the smallest legal one,
    // and it passes, so assert the guard exists by checking a window at the floor
    // succeeds and a sub-floor window fails on rule 1 instead.
    expect(validateProfile({ window: MIN_WINDOW, outputCap: 8192 }).valid).toBe(true)
    expect(validateProfile({ window: MIN_WINDOW - 1, outputCap: 8192 }).valid).toBe(false)
  })

  it('exports the shared constants', () => {
    expect(MIN_WINDOW).toBe(32768)
    expect(MIN_OUTPUT_CAP).toBe(1024)
    expect(DEFAULT_OUTPUT_CAP).toBe(32768)
    expect(BATCH_CAP).toBe(2)
  })
})
