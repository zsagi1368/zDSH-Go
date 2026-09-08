/**
 * Shared vocabulary for the AutoPilot kernel.
 *
 * The kernel is host-agnostic pure TypeScript: everything host-specific enters
 * through ports and everything module-specific stays behind the facade.
 */

/** Closed vocabulary of failure modes. Every async edge converges here. */
export type FailureKind =
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'schema'
  | 'budget'
  | 'circuit-open'

/** The three capability modules mounted on the kernel. */
export type ModuleId = 'continue' | 'guard' | 'review'

/** Outcome words shared across modules (aligned with the host approval seam). */
export type DecisionKind = 'allow' | 'deny' | 'ask' | 'delegate' | 'skip'

/** Why an automatic action was skipped. Recorded on `ap/skipped`. */
export type SkipReason =
  | 'permanent-failure'
  | 'cooldown'
  | 'consecutive-limit'
  | 'paused'
  | 'session-paused'
  | 'pending-approval'
  | 'circuit-open'
  | 'no-agent'
  | 'unavailable'

/** Idle-loop signals recognized by the continue module's loop guard. */
export type LoopSignal = 'same-text' | 'short-run' | 'tool-repeat'

/** Which decision layer produced a guard outcome. */
export type DecisionLayer = 'fuse' | 'rules' | 'classifier' | 'human'

/** Risk bucket attached to review verdicts. */
export type RiskLevel = 'low' | 'medium' | 'high'

// ---------------------------------------------------------------------------
// Audit vocabulary (`ap/*`). Nine families, all appended ignorable.
// ---------------------------------------------------------------------------

export const AUDIT_EVENTS = [
  'ap/state',
  'ap/resumed',
  'ap/skipped',
  'ap/loop',
  'ap/decision',
  'ap/grant',
  'ap/verdict',
  'ap/circuit',
  'ap/override',
] as const

export type AuditEventName = (typeof AUDIT_EVENTS)[number]

export interface ApStatePayload {
  enabled: boolean
  modules: Record<ModuleId, boolean>
  source: string
}

export interface ApResumedPayload {
  sessionId: string
  attempt: number
  template: 'continue' | 'continue-max-tokens' | 'loop'
  guardState?: 'pending' | 'done' | 'failed'
  backoffMs: number
}

export interface ApSkippedPayload {
  sessionId: string
  reason: SkipReason
}

export interface ApLoopPayload {
  sessionId: string
  signals: LoopSignal[]
  restarted: boolean
}

export interface ApDecisionPayload {
  sessionId: string
  toolName: string
  layer: DecisionLayer
  outcome: DecisionKind
  reasonDigest?: string
}

export interface ApGrantPayload {
  grantId: string
  phase: 'issued' | 'consumed' | 'settled' | 'expired'
  toolName?: string
  sessionId?: string
}

export interface ApVerdictPayload {
  verdictId: string
  decision: 'allow' | 'deny'
  riskLevel?: RiskLevel
  model?: string
  durationMs?: number
  fallback?: FailureKind
}

export interface ApCircuitPayload {
  action: 'delegate' | 'reject' | 'abort-turn'
  consecutiveDenials: number
  windowDenials: number
  windowSize: number
}

export interface ApOverridePayload {
  overrideId: string
  toolName: string
  ttlMs: number
  phase: 'issued' | 'consumed' | 'expired'
}

export type AuditPayloadMap = {
  'ap/state': ApStatePayload
  'ap/resumed': ApResumedPayload
  'ap/skipped': ApSkippedPayload
  'ap/loop': ApLoopPayload
  'ap/decision': ApDecisionPayload
  'ap/grant': ApGrantPayload
  'ap/verdict': ApVerdictPayload
  'ap/circuit': ApCircuitPayload
  'ap/override': ApOverridePayload
}

/**
 * Events whose payload produces model-visible injected text. The invariant
 * "model-visible ⟺ recorded" is checked against exactly these.
 */
export const VISIBLE_AUDIT_EVENTS: readonly AuditEventName[] = [
  'ap/resumed',
  'ap/decision',
  'ap/circuit',
  'ap/verdict',
]

export interface AuditEventFor<N extends AuditEventName> {
  name: N
  /** Stable correlation id, embedded in any model-visible marker. */
  id: string
  /** Epoch millis. */
  at: number
  data: AuditPayloadMap[N]
}

/**
 * Discriminated union: switching on `event.name` narrows `event.data`.
 */
export type AuditEvent = {
  [N in AuditEventName]: AuditEventFor<N>;
}[AuditEventName]
