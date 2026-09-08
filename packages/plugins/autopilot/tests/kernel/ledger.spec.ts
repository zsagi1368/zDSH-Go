import { describe, expect, it } from 'vitest'
import {
  LedgerHub,
  StatsCounters,
  TurnBudgets,
  effectiveCooldown,
} from '../../src/kernel/ledger.js'

class FakeClock {
  private t = 1_000_000
  now(): number {
    return this.t
  }
  advance(ms: number): void {
    this.t += ms
  }
}

const backoff = { baseMs: 20_000, factor: 2, capMs: 300_000 }

describe('backoff math', () => {
  it('doubles from base and caps', () => {
    expect(effectiveCooldown(0, backoff)).toBe(20_000)
    expect(effectiveCooldown(1, backoff)).toBe(40_000)
    expect(effectiveCooldown(2, backoff)).toBe(80_000)
    expect(effectiveCooldown(10, backoff)).toBe(300_000)
  })
})

describe('attempt-before-side-effect accounting', () => {
  it('beginAttempt books the timestamp before the caller acts', () => {
    const clock = new FakeClock()
    const hub = new LedgerHub(new StatsCounters(clock))
    const ledger = hub.session('s1', backoff)

    // The caller books first, THEN attempts the side effect (which may throw).
    const cooldown = ledger.beginAttempt(clock.now())
    let sendThrew = false
    try {
      throw new Error('send failed')
    } catch {
      sendThrew = true
    }

    expect(sendThrew).toBe(true)
    expect(cooldown).toBeGreaterThan(0)
    clock.advance(1)
    expect(ledger.inCooldown(clock.now())).toBe(true)

    // After the full cooldown window the session is ready again.
    clock.advance(20_000)
    expect(ledger.inCooldown(clock.now())).toBe(false)
  })

  it('failed attempts escalate the next cooldown via consecutive counter', () => {
    const clock = new FakeClock()
    const hub = new LedgerHub(new StatsCounters(clock))
    const ledger = hub.session('s1', backoff)

    ledger.beginAttempt(clock.now())
    expect(ledger.consecutive).toBe(1)
    ledger.beginAttempt(clock.now())
    expect(ledger.consecutive).toBe(2)
    // Two spent attempts → next window is base×factor^1 = 40s after last attempt.
    clock.advance(20_000)
    expect(ledger.inCooldown(clock.now())).toBe(true)
    clock.advance(20_001)
    expect(ledger.inCooldown(clock.now())).toBe(false)

    ledger.noteRecovery()
    expect(ledger.consecutive).toBe(0)

    // After recovery the curve resets to the base window.
    ledger.beginAttempt(clock.now())
    clock.advance(19_999)
    expect(ledger.inCooldown(clock.now())).toBe(true)
    clock.advance(1)
    expect(ledger.inCooldown(clock.now())).toBe(false)
  })

  it('user message clears the consecutive counter', () => {
    const clock = new FakeClock()
    const hub = new LedgerHub(new StatsCounters(clock))
    const ledger = hub.session('s1', backoff)
    ledger.beginAttempt(clock.now())
    ledger.beginAttempt(clock.now())
    ledger.noteUserMessage()
    expect(ledger.consecutive).toBe(0)
  })

  it('closing a session evicts its state', () => {
    const clock = new FakeClock()
    const hub = new LedgerHub(new StatsCounters(clock))
    hub.session('gone', backoff)
    hub.closeSession('gone')
    const fresh = hub.session('gone', backoff)
    expect(fresh.consecutive).toBe(0)
  })
})

describe('dual turn budgets', () => {
  it('decision and failure budgets are independent; cancelled is free', () => {
    const budgets = new TurnBudgets(2, 1)
    expect(budgets.tryConsumeDecision()).toBe(true)
    budgets.recordFailure('timeout')
    expect(budgets.failureBudgetExhausted).toBe(true)
    // Cancelled failures do not burn anything.
    budgets.recordFailure('cancelled')
    expect(budgets.failuresRemaining).toBe(0)
    expect(budgets.tryConsumeDecision()).toBe(true)
    expect(budgets.decisionBudgetExhausted).toBe(true)
    expect(budgets.tryConsumeDecision()).toBe(false)
  })

  it('turn lifecycle keys per session and cleans up', () => {
    const clock = new FakeClock()
    const hub = new LedgerHub(new StatsCounters(clock))
    const t1 = hub.turn('s1', 'turn-1', 3, 3)
    t1.tryConsumeDecision()
    hub.endTurn('s1', 'turn-1')
    const t2 = hub.turn('s1', 'turn-1', 3, 3)
    expect(t2.decisionsRemaining).toBe(3)
  })
})

describe('stats counters', () => {
  it('keeps today and all-time buckets with daily rollover', () => {
    const clock = new FakeClock()
    const stats = new StatsCounters(clock)
    stats.inc('sent')
    stats.inc('sent')
    expect(stats.get('sent')).toBe(2)
    expect(stats.get('sent', 'all')).toBe(2)

    // Jump across midnight by rebuilding on a changed day key.
    const later = new StatsCounters(clock, stats.exportSnapshot())
    // Force dayKey change by exporting/restoring against an advanced date:
    const snapshot = stats.exportSnapshot()
    snapshot.dayKey = '2000-01-01'
    const rolled = new StatsCounters(clock, snapshot)
    rolled.inc('sent')
    expect(rolled.get('sent')).toBe(1) // fresh today
    expect(rolled.get('sent', 'all')).toBe(3) // cumulative preserved
    void later
  })

  it('restores from persistence and tracks per-module counters', () => {
    const fakeEpochDay = new Date(1_000_000).toISOString().slice(0, 10) // FakeClock's "today"
    const saved = {
      dayKey: fakeEpochDay,
      today: { sent: 5 },
      all: { sent: 9 },
      perModule: { continue: { sent: 5 }, guard: {}, review: {} },
    }
    const stats = new StatsCounters(new FakeClock(), saved)
    expect(stats.get('sent')).toBe(5)
    expect(stats.get('sent', 'all')).toBe(9)
    stats.inc('denied', 1, 'guard')
    expect(stats.moduleTotals('guard')['denied']).toBe(1)
    expect(stats.moduleTotals('continue')['sent']).toBe(5)
  })
})
