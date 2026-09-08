import { describe, expect, it } from 'vitest'
import {
  countsAgainstFailureBudget,
  isCancelled,
  isFailureKind,
  toSafeOutcome,
} from '../../src/kernel/failures.js'
import type { FailureKind } from '../../src/kernel/types.js'

describe('failure vocabulary', () => {
  const all: FailureKind[] = [
    'timeout',
    'cancelled',
    'unavailable',
    'schema',
    'budget',
    'circuit-open',
  ]

  it('recognizes every kind and rejects junk', () => {
    for (const kind of all) expect(isFailureKind(kind)).toBe(true)
    expect(isFailureKind('nope')).toBe(false)
    expect(isFailureKind(undefined)).toBe(false)
  })

  it('maps through a total table — every kind must have a row', () => {
    const table: Record<FailureKind, string> = {
      timeout: 'retry-later',
      cancelled: 'leave-alone',
      unavailable: 'fallback',
      schema: 'reject',
      budget: 'defer-to-human',
      'circuit-open': 'stand-down',
    }
    for (const kind of all) {
      expect(toSafeOutcome(kind, table)).toBe(table[kind])
    }
  })

  it('treats cancellation as budget-free', () => {
    expect(isCancelled('cancelled')).toBe(true)
    expect(isCancelled('timeout')).toBe(false)
    expect(countsAgainstFailureBudget('cancelled')).toBe(false)
    for (const kind of all.filter(k => k !== 'cancelled')) {
      expect(countsAgainstFailureBudget(kind)).toBe(true)
    }
  })
})
