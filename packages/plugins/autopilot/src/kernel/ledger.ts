/**
 * Accounting engine: cooldowns, backoff, dual budgets, and stats.
 *
 * Core invariant — "book before you act": `beginAttempt` records the attempt
 * timestamp BEFORE any side effect is performed, so a throwing send still
 * consumes cooldown. Failed attempts count against consecutive limits; user-
 * or shutdown-driven cancellations never burn failure budgets.
 */
import { countsAgainstFailureBudget } from './failures.js'
import type { FailureKind, ModuleId } from './types.js'

// ---------------------------------------------------------------------------
// Ports (host capabilities injected by the facade)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number
}

export interface RandomSource {
  /** Short unguessable token for correlation ids. */
  token(): string
}

/** Synchronous snapshot persistence; adapters should front a cached file. */
export interface StatsPersistence {
  load(): StatsSnapshot | undefined
  save(snapshot: StatsSnapshot): void
}

export const systemClock: Clock = { now: () => Date.now() }

export function createTokenSource(random = Math.random): RandomSource {
  return {
    token: () => Math.floor(random() * 0xffffffff).toString(36) + Date.now().toString(36),
  }
}

// ---------------------------------------------------------------------------
// Cooldown & backoff
// ---------------------------------------------------------------------------

export interface BackoffParams {
  baseMs: number
  factor: number
  capMs: number
}

export function effectiveCooldown(consecutive: number, params: BackoffParams): number {
  const raw = params.baseMs * Math.pow(params.factor, Math.max(0, consecutive))
  return Math.min(params.capMs, raw)
}

// ---------------------------------------------------------------------------
// Dual budgets per open turn
// ---------------------------------------------------------------------------

export class TurnBudgets {
  private decisionsUsed = 0
  private failuresUsed = 0

  constructor(
    readonly maxDecisions: number,
    readonly maxFailures: number,
  ) {}

  get decisionsRemaining(): number {
    return this.maxDecisions - this.decisionsUsed
  }

  get failuresRemaining(): number {
    return this.maxFailures - this.failuresUsed
  }

  get decisionBudgetExhausted(): boolean {
    return this.decisionsRemaining <= 0
  }

  get failureBudgetExhausted(): boolean {
    return this.failuresRemaining <= 0
  }

  /** Reserve one real decision slot. Returns false when exhausted. */
  tryConsumeDecision(): boolean {
    if (this.decisionBudgetExhausted) return false
    this.decisionsUsed += 1
    return true
  }

  /**
   * Record a failed decision attempt. Cancelled failures do NOT burn the
   * failure budget (the user pulled the plug, not the reviewer).
   */
  recordFailure(kind: FailureKind): void {
    if (countsAgainstFailureBudget(kind)) this.failuresUsed += 1
  }
}

// ---------------------------------------------------------------------------
// Per-session ledger
// ---------------------------------------------------------------------------

export class SessionLedger {
  private lastAttemptAt = 0
  private consecutiveResumes = 0

  constructor(private readonly backoff: BackoffParams) {}

  /** Window that applies after the attempt just booked: retry #n waits base×factor^(n-1). */
  private currentWindow(): number {
    return effectiveCooldown(Math.max(0, this.consecutiveResumes - 1), this.backoff)
  }

  /**
   * Book the attempt BEFORE performing the side effect. The returned cooldown
   * applies from now on regardless of success.
   */
  beginAttempt(now: number): number {
    this.lastAttemptAt = now
    this.consecutiveResumes += 1
    return this.currentWindow()
  }

  noteRecovery(): void {
    this.consecutiveResumes = 0
  }

  noteUserMessage(): void {
    this.consecutiveResumes = 0
  }

  get consecutive(): number {
    return this.consecutiveResumes
  }

  readyAt(): number {
    return this.lastAttemptAt + this.currentWindow()
  }

  inCooldown(now: number): boolean {
    return now < this.readyAt()
  }
}

// ---------------------------------------------------------------------------
// Stats buckets
// ---------------------------------------------------------------------------

export type StatsBucketName = 'today' | 'all'

export interface StatsSnapshot {
  dayKey: string
  today: Record<string, number>
  all: Record<string, number>
  perModule: Record<ModuleId, Record<string, number>>
}

function emptyBuckets(): Record<string, number> {
  return {}
}

function dayKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export class StatsCounters {
  private snapshot: StatsSnapshot

  constructor(
    private readonly clock: Clock,
    restored?: StatsSnapshot,
  ) {
    this.snapshot =
      restored && restored.dayKey === dayKeyOf(clock.now())
        ? restored
        : {
          dayKey: dayKeyOf(clock.now()),
          today: emptyBuckets(),
          all: restored?.all ?? {},
          perModule: restored?.perModule ?? { continue: {}, guard: {}, review: {} },
        }
  }

  inc(name: string, by = 1, moduleId?: ModuleId): void {
    // Roll the daily bucket on date change.
    const key = dayKeyOf(this.clock.now())
    if (key !== this.snapshot.dayKey) {
      this.snapshot = { ...this.snapshot, dayKey: key, today: emptyBuckets() }
    }
    this.snapshot.today[name] = (this.snapshot.today[name] ?? 0) + by
    this.snapshot.all[name] = (this.snapshot.all[name] ?? 0) + by
    if (moduleId) {
      const bucket = this.snapshot.perModule[moduleId]
      bucket[name] = (bucket[name] ?? 0) + by
    }
  }

  get(name: string, bucket: StatsBucketName = 'today'): number {
    const source = bucket === 'today' ? this.snapshot.today : this.snapshot.all
    return source[name] ?? 0
  }

  moduleTotals(moduleId: ModuleId, bucket: StatsBucketName = 'today'): Record<string, number> {
    if (bucket === 'all') return this.snapshot.perModule[moduleId]
    // Today-per-module is derivable only if tracked; keep 'today' module view
    // equal to the shared today counters for names touched by that module.
    return Object.fromEntries(
      Object.entries(this.snapshot.perModule[moduleId]).filter(([k]) => k in this.snapshot.today),
    )
  }

  reset(): void {
    this.snapshot = {
      dayKey: dayKeyOf(this.clock.now()),
      today: emptyBuckets(),
      all: emptyBuckets(),
      perModule: { continue: {}, guard: {}, review: {} },
    }
  }

  exportSnapshot(): StatsSnapshot {
    return JSON.parse(JSON.stringify(this.snapshot)) as StatsSnapshot
  }
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

export class LedgerHub {
  private sessions = new Map<string, SessionLedger>()
  private turns = new Map<string, TurnBudgets>()

  constructor(
    private readonly stats: StatsCounters,
  ) {}

  session(sessionId: string, backoff: BackoffParams): SessionLedger {
    let ledger = this.sessions.get(sessionId)
    if (!ledger) {
      ledger = new SessionLedger(backoff)
      this.sessions.set(sessionId, ledger)
    }
    return ledger
  }

  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
    // Deleting during Map iteration is safe per spec and cannot resurface keys.
    for (const key of this.turns.keys()) {
      if (key.startsWith(`${sessionId}#`)) this.turns.delete(key)
    }
  }

  turn(sessionId: string, turnId: string, maxDecisions: number, maxFailures: number): TurnBudgets {
    const key = `${sessionId}#${turnId}`
    let budgets = this.turns.get(key)
    if (!budgets) {
      budgets = new TurnBudgets(maxDecisions, maxFailures)
      this.turns.set(key, budgets)
    }
    return budgets
  }

  endTurn(sessionId: string, turnId: string): void {
    this.turns.delete(`${sessionId}#${turnId}`)
  }

  get statsCounters(): StatsCounters {
    return this.stats
  }
}
