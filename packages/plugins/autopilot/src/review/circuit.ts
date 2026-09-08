/**
 * Review circuit breaker.
 *
 * Defaults are DERIVED, not vibes: window 6-of-10 is reachable only because a
 * turn allows at most 10 real AI verdicts — a stricter window could never fire
 * first, a looser one would not protect the human chain.
 */
import type { RandomSource } from '../kernel/ledger.js'

export interface CircuitConfig {
  consecutiveDenials: number
  windowSize: number
  windowDenials: number
  action: 'delegate' | 'reject' | 'abort-turn'
}

export const CIRCUIT_DEFAULTS: CircuitConfig = {
  consecutiveDenials: 3,
  windowSize: 10,
  windowDenials: 6,
  action: 'delegate',
}

export interface CircuitState {
  tripped: boolean
  action: CircuitConfig['action']
}

export class ReviewCircuit {
  private consecutive = 0
  /** Denial outcomes within the sliding window (true = denial). */
  private window: boolean[] = []

  constructor(
    readonly config: CircuitConfig = CIRCUIT_DEFAULTS,
    private readonly rng?: RandomSource,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(decision: 'allow' | 'deny', escalatedToDenial = false): void {
    const isDenial = decision === 'deny' || escalatedToDenial
    this.window.push(isDenial)
    while (this.window.length > this.config.windowSize) this.window.shift()
    if (isDenial) {
      this.consecutive += 1
    } else {
      this.consecutive = 0
    }
  }

  get state(): CircuitState {
    return {
      tripped: this.isTripped(),
      action: this.config.action,
    }
  }

  isTripped(): boolean {
    if (this.consecutive >= this.config.consecutiveDenials) return true
    const denialsInWindow =
      this.window.filter(d => d).length
    return denialsInWindow >= this.config.windowDenials && this.window.length >= Math.min(this.config.windowSize, this.config.windowDenials)
  }

  /** Reset after human intervention or an explicit cool-off. */
  reset(): void {
    this.consecutive = 0
    this.window = []
  }

  snapshotToken(): string {
    void this.rng
    void this.now
    return `${this.consecutive}:${this.window.map(d => (d ? '1' : '0')).join('')}`
  }
}
