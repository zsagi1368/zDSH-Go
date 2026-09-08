/**
 * ContinueScheduler — per-session state machine for auto-resume.
 *
 * Two-gate discipline: conditions are checked when the grace timer is armed
 * AND again when it fires (config and pause state may change inside the
 * window). Cross-module gates (pause / pending approval / circuit) live in the
 * coordinator and are consulted through `requestResume`, which returns the
 * dispatch outcome so a DEFERRED result reschedules instead of dropping.
 *
 * The scheduler never sends by itself: `adapters.sendFollowup` performs the
 * side effect after `beginAttempt` has booked the attempt.
 */
import type { DispatchOutcome } from '../kernel/coordinator.js'
import type { Clock, RandomSource } from '../kernel/ledger.js'
import { effectiveCooldown } from '../kernel/ledger.js'
import type { BackoffParams } from '../kernel/ledger.js'
import type {
  ApResumedPayload,
  ApSkippedPayload,
} from '../kernel/types.js'
import type { LoopGuard } from './loopguard.js'

export interface SchedulerAdapters {
  /** Ask the kernel coordinator to gate and route this resume request. */
  requestResume(sessionId: string): DispatchOutcome[]
  /** Perform the actual followup send. Returns false when no live agent exists. */
  sendFollowup(sessionId: string, text: string, template: 'continue' | 'continue-max-tokens' | 'loop'): boolean
  setTimeoutMs(fn: () => void, ms: number): () => void
  auditResumed(payload: ApResumedPayload): void
  auditSkipped(payload: ApSkippedPayload): void
}

interface SessionState {
  pendingTimer?: { cancel: () => void; template: 'continue' | 'continue-max-tokens' }
  pausedUntil: number
}

export class ContinueScheduler {
  private sessions = new Map<string, SessionState>()

  constructor(
    private readonly adapters: SchedulerAdapters,
    private readonly clock: Clock,
    private readonly rng: RandomSource,
    private readonly ledgerHub: {
      session(id: string, backoff: BackoffParams): {
        beginAttempt(now: number): number
        inCooldown(now: number): boolean
        consecutive: number
        noteRecovery(): void
        noteUserMessage(): void
      }
    },
    private readonly backoff: BackoffParams,
    private readonly limits: { graceMs: number; maxConsecutive: number },
  ) {}

  // ------------------------------------------------------------------
  // State transitions
  // ------------------------------------------------------------------

  beginTurn(sessionId: string): void {
    this.cancelPending(sessionId) // host healed itself — cancel quietly
  }

  noteUserMessage(sessionId: string): void {
    this.cancelPending(sessionId)
    this.ledgerHub.session(sessionId, this.backoff).noteUserMessage()
  }

  pauseSession(sessionId: string, durationMs: number): void {
    const state = this.stateFor(sessionId)
    state.pausedUntil = this.clock.now() + durationMs
    this.cancelPending(sessionId)
  }

  resumeSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state) state.pausedUntil = 0
  }

  /** Explicit human action — bypasses every gate except "agent exists". */
  resumeNow(sessionId: string, text: string): boolean {
    return this.adapters.sendFollowup(sessionId, text, 'continue')
  }

  cancelPending(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state?.pendingTimer) {
      state.pendingTimer.cancel()
      delete state.pendingTimer
    }
  }

  closeSession(sessionId: string): void {
    this.cancelPending(sessionId)
    this.sessions.delete(sessionId)
  }

  // ------------------------------------------------------------------
  // Scheduling
  // ------------------------------------------------------------------

  /**
   * Called after the detector decided a turn is resume-worthy.
   * Returns true when a grace timer was armed.
   */
  schedule(
    sessionId: string,
    template: 'continue' | 'continue-max-tokens',
    buildText: () => string,
  ): boolean {
    if (!this.gateLocal(sessionId)) {
      this.adapters.auditSkipped({ sessionId, reason: this.localSkipReason(sessionId) })
      return false
    }
    const state = this.stateFor(sessionId)
    if (state.pendingTimer) return false // one pending resume per session

    const timer = this.adapters.setTimeoutMs(() => {
      delete state.pendingTimer
      this.fire(sessionId, template, buildText)
    }, this.limits.graceMs)
    state.pendingTimer = { cancel: timer, template }
    return true
  }

  private fire(
    sessionId: string,
    template: 'continue' | 'continue-max-tokens',
    buildText: () => string,
  ): void {
    // Second gate — identical checks, because the world changed during grace.
    if (!this.gateLocal(sessionId)) {
      this.adapters.auditSkipped({ sessionId, reason: this.localSkipReason(sessionId) })
      return
    }
    const ledger = this.ledgerHub.session(sessionId, this.backoff)
    if (ledger.consecutive >= this.limits.maxConsecutive) {
      this.adapters.auditSkipped({ sessionId, reason: 'consecutive-limit' })
      return
    }
    if (ledger.inCooldown(this.clock.now())) {
      this.adapters.auditSkipped({ sessionId, reason: 'cooldown' })
      return
    }

    // Cross-module gates: coordinator may suppress or defer.
    const outcomes = this.adapters.requestResume(sessionId)
    const verdict = outcomes.find(o => o.status !== 'dispatched') ?? outcomes[0]
    if (verdict?.status === 'deferred') {
      // Re-arm shortly; do not burn cooldown for a deferred attempt.
      const retryAt = Math.min(60_000, this.limits.graceMs * 2)
      const state = this.stateFor(sessionId)
      const timer = this.adapters.setTimeoutMs(() => {
        delete state.pendingTimer
        this.fire(sessionId, template, buildText)
      }, retryAt)
      state.pendingTimer = { cancel: timer, template }
      return
    }
    if (verdict && verdict.status !== 'dispatched') {
      this.adapters.auditSkipped({ sessionId, reason: verdict.reason ?? 'paused' })
      return
    }

    // Book BEFORE the side effect; failures consume the attempt too.
    const backoffApplied = ledger.beginAttempt(this.clock.now())
    const sent = this.adapters.sendFollowup(sessionId, buildText(), template)
    if (!sent) {
      this.adapters.auditSkipped({ sessionId, reason: 'no-agent' })
      return
    }
    this.adapters.auditResumed({
      sessionId,
      attempt: ledger.consecutive,
      template,
      backoffMs: backoffApplied,
    })
  }

  /** Recovery bookkeeping after an assistant turn completes successfully. */
  noteRecoveredTurn(sessionId: string): void {
    this.ledgerHub.session(sessionId, this.backoff).noteRecovery()
  }

  nextReadyIn(sessionId: string, loopGuard: LoopGuard): number {
    void loopGuard
    const ledger = this.ledgerHub.session(sessionId, this.backoff)
    return effectiveCooldown(Math.max(0, ledger.consecutive - 1), this.backoff)
  }

  makeAttemptId(): string {
    return `att_${this.clock.now().toString(36)}_${this.rng.token()}`
  }

  private stateFor(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = { pausedUntil: 0 }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private gateLocal(sessionId: string): boolean {
    const state = this.sessions.get(sessionId)
    if (state?.pausedUntil && this.clock.now() < state.pausedUntil) return false
    if (state?.pendingTimer) return false
    return true
  }

  private localSkipReason(sessionId: string) {
    const state = this.sessions.get(sessionId)
    if (state?.pausedUntil && this.clock.now() < state.pausedUntil) {
      return 'session-paused' as const
    }
    return 'cooldown' as const
  }
}
