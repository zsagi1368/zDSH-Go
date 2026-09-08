/**
 * Bounded-restart accounting shared by the guardian entry and the runtime
 * surface: at most `max` restarts inside any `windowMs`, then the circuit
 * stays open (give-up) until an operator intervenes.
 */
export class RestartBudget {
  private attempts: number[] = []

  constructor(
    private readonly windowMs = 5 * 60_000,
    private readonly max = 3,
  ) {}

  /** Would another restart right now still be within budget? */
  canRestart(nowMs: number): boolean {
    this.prune(nowMs)
    return this.attempts.length < this.max
  }

  record(nowMs: number): void {
    this.prune(nowMs)
    this.attempts.push(nowMs)
  }

  /** Number of restarts already spent in the current window. */
  used(nowMs: number): number {
    this.prune(nowMs)
    return this.attempts.length
  }

  reset(): void {
    this.attempts = []
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs
    this.attempts = this.attempts.filter(t => t >= cutoff)
  }
}

export type ProbeVerdict = { kind: 'healthy' } | { kind: 'unhealthy' }

export type GuardianAction = 'none' | 'restart' | 'give-up'

/** Pure decision step used by the guardian loop on every probe tick. */
export function decideAction(input: {
  verdict: ProbeVerdict
  budget: RestartBudget
  nowMs: number
}): GuardianAction {
  if (input.verdict.kind === 'healthy') return 'none'
  return input.budget.canRestart(input.nowMs) ? 'restart' : 'give-up'
}
