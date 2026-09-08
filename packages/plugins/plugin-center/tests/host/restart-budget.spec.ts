import { describe, expect, it } from 'vitest'
import { decideAction, RestartBudget } from '../../src/host/restart-budget.js'

describe('restart budget', () => {
  it('allows at most three restarts per five minute window', () => {
    const budget = new RestartBudget()
    const t0 = 1_000_000
    expect(budget.canRestart(t0)).toBe(true)
    budget.record(t0)
    budget.record(t0 + 60_000)
    budget.record(t0 + 120_000)
    expect(budget.canRestart(t0 + 130_000)).toBe(false)
    expect(budget.used(t0 + 130_000)).toBe(3)
  })

  it('frees the window as attempts age out', () => {
    const budget = new RestartBudget()
    const t0 = 2_000_000
    for (let i = 0; i < 3; i += 1) budget.record(t0 + i * 1000)
    expect(budget.canRestart(t0 + 60_000)).toBe(false)
    // five minutes after the LAST attempt, every record has aged out
    const afterWindow = t0 + 2 * 1000 + 5 * 60_000 + 1
    expect(budget.used(afterWindow)).toBe(0)
    expect(budget.canRestart(afterWindow)).toBe(true)
  })

  it('reset clears history immediately', () => {
    const budget = new RestartBudget()
    budget.record(10)
    budget.record(11)
    budget.record(12)
    budget.reset()
    expect(budget.canRestart(13)).toBe(true)
  })
})

describe('guardian decision step', () => {
  it('stays quiet while healthy', () => {
    const action = decideAction({
      verdict: { kind: 'healthy' },
      budget: new RestartBudget(),
      nowMs: 1,
    })
    expect(action).toBe('none')
  })

  it('restarts on failure while budget remains, then gives up', () => {
    const budget = new RestartBudget()
    let nowMs = 100
    for (let i = 0; i < 3; i += 1) {
      const action = decideAction({ verdict: { kind: 'unhealthy' }, budget, nowMs })
      expect(action).toBe('restart')
      budget.record(nowMs)
      nowMs += 30_000
    }
    expect(decideAction({ verdict: { kind: 'unhealthy' }, budget, nowMs })).toBe('give-up')
  })
})
