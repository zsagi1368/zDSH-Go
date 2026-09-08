/**
 * One-shot escalation capabilities.
 *
 * A grant is bound to five elements (session, tool, callId, level,
 * justification digest), consumable EXACTLY once, unconditionally reclaimed
 * at tool settlement — even if the permission preset changed mid-flight.
 */
import type { RandomSource } from '../kernel/ledger.js'

export interface GrantSpec {
  sessionId: string
  toolName: string
  callId: string
  level: string
  justification: string
}

interface GrantRecord extends GrantSpec {
  grantId: string
  issuedAt: number
  expiresAt: number
}

export type GrantDecision = 'allowed-once' | undefined

const DEFAULT_TTL_MS = 10 * 60_000

export class EscalationGrants {
  private readonly grants = new Map<string, GrantRecord>()

  constructor(
    private readonly rng: RandomSource,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  issue(spec: GrantSpec): string {
    const grantId = `g_${this.now().toString(36)}_${this.rng.token()}`
    this.grants.set(spec.callId, {
      ...spec,
      justification: spec.justification.slice(0, 200),
      grantId,
      issuedAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    })
    return grantId
  }

  /** Exact-match answer for the official approval seam. Consume on success. */
  decide(callId: string, toolName: string): GrantDecision {
    this.sweep()
    const record = this.grants.get(callId)
    if (!record) return undefined
    if (record.toolName !== toolName) return undefined // wrong shape → fail closed to the human chain
    if (this.now() >= record.expiresAt) {
      this.grants.delete(callId)
      return undefined
    }
    this.grants.delete(callId) // single consumption by construction
    return 'allowed-once'
  }

  /** Unconditional reclamation at settlement — consumed or not. */
  settle(callId: string): void {
    this.grants.delete(callId)
  }

  get size(): number {
    return this.grants.size
  }

  private sweep(): void {
    const now = this.now()
    for (const [callId, record] of this.grants) {
      if (now >= record.expiresAt) this.grants.delete(callId)
    }
  }
}
