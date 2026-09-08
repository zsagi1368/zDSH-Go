import { describe, expect, it } from 'vitest'
import { DEFAULTS, resolveConfig, walkDefaults } from '../../src/kernel/defaults.js'
import { ProbeRegistry } from '../../src/kernel/probes.js'

describe('resolveConfig', () => {
  it('returns clamped defaults with the budget sentinel resolved', () => {
    const resolved = resolveConfig(DEFAULTS, {})
    expect(resolved.review.maxFailuresPerTurn).toBe(DEFAULTS.review.maxReviewsPerTurn)
    expect(resolved.continue.graceMs).toBe(3000)
  })

  it('merges user patches deeply and resolves the sentinel against user values', () => {
    const resolved = resolveConfig(DEFAULTS, {
      review: { maxReviewsPerTurn: 4 },
      continue: { cooldownMs: 5_000 },
    })
    expect(resolved.review.maxFailuresPerTurn).toBe(4)
    expect(resolved.continue.cooldownMs).toBe(5_000)
    expect(resolved.guard.enabled).toBe(true) // untouched section intact
  })

  it('clamps numbers back inside range', () => {
    const resolved = resolveConfig(DEFAULTS, {
      continue: { graceMs: -5, maxConsecutive: 0 },
      guard: { classifierTimeoutMs: 999_999 },
    })
    expect(resolved.continue.graceMs).toBe(0)
    expect(resolved.continue.maxConsecutive).toBe(1)
    expect(resolved.guard.classifierTimeoutMs).toBe(60_000)
  })

  it('ignores unknown keys and type-mismatched values (fail-soft)', () => {
    const resolved = resolveConfig(DEFAULTS, {
      bogus: true,
      continue: { graceMs: 'fast' as unknown as number },
    })
    expect(resolved.continue.graceMs).toBe(3000)
    expect((resolved as unknown as Record<string, unknown>)['bogus']).toBeUndefined()
  })

  it('walks every leaf with a dotted path', () => {
    const seen = new Map<string, unknown>()
    walkDefaults(DEFAULTS as unknown as Record<string, unknown>, (path, value) => seen.set(path, value))
    expect(seen.get('continue.graceMs')).toBe(3000)
    expect(seen.get('review.circuit.consecutiveDenials')).toBe(3)
    expect(seen.has('global.paused')).toBe(true)
  })
})

describe('probe registry', () => {
  it('runs precheck → probe and caches the verdict', () => {
    const probes = new ProbeRegistry()
    let probeRuns = 0
    probes.register({
      id: 'seam/x',
      description: 'host exposes service x',
      precheck: () => true,
      probe: () => {
        probeRuns += 1
        return true
      },
    })
    expect(probes.probe('seam/x').state).toBe('available')
    probes.probe('seam/x')
    expect(probeRuns).toBe(1)
  })

  it('marks degraded when precheck fails without running the probe', () => {
    const probes = new ProbeRegistry()
    probes.register({
      id: 'seam/y',
      description: 'y',
      precheck: () => 'missing service',
      probe: () => true,
    })
    const status = probes.probe('seam/y')
    expect(status.state).toBe('degraded')
    expect(status.detail).toContain('missing service')
  })

  it('reports unavailable for unregistered assumptions', () => {
    const probes = new ProbeRegistry()
    expect(probes.status('nope').state).toBe('unavailable')
    expect(probes.all()).toHaveLength(0)
  })

  it('survives throwing probes as degradation, not crashes', () => {
    const probes = new ProbeRegistry()
    probes.register({
      id: 'seam/z',
      description: 'z',
      probe: () => {
        throw new Error('boom')
      },
    })
    expect(probes.probe('seam/z').state).toBe('degraded')
  })
})
