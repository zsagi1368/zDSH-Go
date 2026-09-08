/**
 * Review module — second-model approval review on the approval waterfall.
 *
 * Claim conjunction (ALL must hold, else pass through with next()):
 *   not a reviewer's own ask ∧ session enabled ∧ policy=ai
 *   ∧ decision budget available ∧ circuit not tripped ∧ audit correlation ok.
 *
 * Failure total-function: any reviewer failure converges on the closed
 * FailureKind vocabulary and maps through fallbackPolicy (default rejected).
 * Cancellation settles as cancelled and burns NO failure budget.
 */
import type { Kernel } from '../kernel/facade.js'
import { makeAuditEvent, buildMarker } from '../kernel/audit.js'
import type { AuditEvent } from '../kernel/types.js'
import type { FailureKind } from '../kernel/types.js'
import { ReviewCircuit } from './circuit.js'
import type { CircuitConfig } from './circuit.js'
import { FeedbackLoop } from './feedback.js'
import { buildReviewPrompt, parseVerdict, resolvePolicy } from './reviewer.js'
import type { ReviewRequestContext, RiskRule, ToolPolicy } from './reviewer.js'

export interface ReviewAdapters {
  /** Session-level enablement (fold of ap/state events). */
  sessionEnabled(sessionId: string): boolean
  /** Audit correlation: was there an unanswered approval/asked for this call? */
  hasPendingApprovalAsked(callId: string): boolean
  /** Start the read-only reviewer subagent. Resolves raw structured output. */
  runReviewer(prompt: string): Promise<{ output: unknown; stopReason?: string; model?: string; durationMs: number }>
  /** Register this callId as belonging to a reviewer-spawned session (recursion guard input). */
  markReviewerSession(sessionId: string): void
  unmarkReviewerSession(sessionId: string): void
  isReviewerSession(agentSessionId: string): boolean
  /** Inject replacement text into an isError tool result. */
  injectToolResultText(callId: string, text: string): void
  appendAudit(event: AuditEvent): void
}

export interface CreateReviewModuleDeps {
  kernel: Kernel
  options: {
    enabled: boolean
    maxReviewsPerTurn: number
    maxFailuresPerTurn: number
    fallbackPolicy: 'rejected' | 'delegate' | 'allow-once'
    circuit: CircuitConfig
    overrideTtlMs: number
    reasonMaxChars: number
    reviewerTimeoutMs: number
    riskRules?: Array<{ pattern: string; policy: ToolPolicy }>
    overrides?: Record<string, ToolPolicy>
    defaultPolicy?: ToolPolicy
  }
  adapters: ReviewAdapters
}

export interface ApprovalRequestLike2 {
  sessionId: string
  agentSessionId: string
  callId: string
  toolName: string
  reason: string
  turnId: string
}

export type ReviewOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'delegate'

export function createReviewModule(deps: CreateReviewModuleDeps) {
  const { kernel, options, adapters } = deps

  const circuit = new ReviewCircuit(options.circuit, kernel.rng, () => kernel.clock.now())
  const feedback = new FeedbackLoop(() => kernel.clock.now())
  const overrides = new Map<string, { overrideId: string; expiresAt: number }>()

  const rules: RiskRule[] = (options.riskRules ?? []).map(r => ({
    pattern: new RegExp(r.pattern, 'i'),
    policy: r.policy,
  }))

  function sweepOverrides(): void {
    const now = kernel.clock.now()
    for (const [toolName, entry] of overrides) {
      if (now >= entry.expiresAt) overrides.delete(toolName)
    }
  }

  /** Human one-shot approval context for the next review of this tool. */
  const approveNext = (toolName: string): string => {
    sweepOverrides()
    const overrideId = `ov_${kernel.clock.now().toString(36)}_${(kernel.rng).token()}`
    overrides.set(toolName.toLowerCase(), {
      overrideId,
      expiresAt: kernel.clock.now() + options.overrideTtlMs,
    })
    adapters.appendAudit(
      makeAuditEvent('ap/override', { overrideId, toolName, ttlMs: options.overrideTtlMs, phase: 'issued' }, kernel.clock.now(), kernel.rng),
    )
    return overrideId
  }

  const handleApprovalRequest = async (request: ApprovalRequestLike2): Promise<ReviewOutcome> => {
    if (!options.enabled) return 'delegate'

    // Recursion guard #1: our own reviewer's asks go straight to humans.
    if (adapters.isReviewerSession(request.agentSessionId)) return 'delegate'

    sweepOverrides()
    if (!adapters.sessionEnabled(request.sessionId)) return 'delegate'

    // Policy table: first matching rule → override → default.
    const policy = resolvePolicy(
      request.toolName,
      request.reason,
      rules,
      options.overrides ?? {},
      options.defaultPolicy ?? 'human',
    )
    if (policy === 'human') return 'delegate'
    if (policy === 'never') {
      const verdictId = `v_${kernel.clock.now().toString(36)}_${(kernel.rng).token()}`
      feedback.record(request.callId, { verdictId, toolName: request.toolName, reason: 'disabled by policy', kind: 'never' })
      adapters.injectToolResultText(
        request.callId,
        `This tool is hard-disabled by policy. ${buildMarker('ap/verdict', verdictId)} Choose another approach.`,
      )
      adapters.appendAudit(
        makeAuditEvent('ap/verdict', { verdictId, decision: 'deny' }, kernel.clock.now(), kernel.rng),
      )
      return 'rejected'
    }

    // Circuit gate.
    const tripped = circuit.isTripped()
    if (tripped) {
      if (circuit.config.action === 'reject') {
        const verdictId = `v_${kernel.clock.now().toString(36)}_${(kernel.rng).token()}`
        feedback.record(request.callId, { verdictId, toolName: request.toolName, reason: 'review circuit open', kind: 'circuit' })
        adapters.injectToolResultText(
          request.callId,
          `Review circuit opened after repeated denials. ${buildMarker('ap/verdict', verdictId)}`,
        )
        adapters.appendAudit(
          makeAuditEvent('ap/circuit', {
            action: 'reject',
            consecutiveDenials: circuit.snapshotToken().split(':')[0] ? Number(circuit.snapshotToken().split(':')[0]) : 0,
            windowDenials: 0,
            windowSize: circuit.config.windowSize,
          }, kernel.clock.now(), kernel.rng),
        )
        return 'rejected'
      }
      return 'delegate' // delegate / abort-turn handled by host chain here
    }

    // Budgets: decisions and failures accounted separately per open turn.
    const budgets = kernel.ledger.turn(request.sessionId, request.turnId, options.maxReviewsPerTurn, options.maxFailuresPerTurn)
    if (!budgets.tryConsumeDecision()) return 'delegate'

    // Audit correlation: no asked event → unavailable, never authorization.
    if (!adapters.hasPendingApprovalAsked(request.callId)) {
      return applyFailure('unavailable', request)
    }

    // Human override context (consumed regardless of verdict below).
    const overrideKey = request.toolName.toLowerCase()
    const overrideEntry = overrides.get(overrideKey)
    let humanOverrideId: string | undefined
    if (overrideEntry && kernel.clock.now() < overrideEntry.expiresAt) {
      humanOverrideId = overrideEntry.overrideId
      overrides.delete(overrideKey)
      adapters.appendAudit(
        makeAuditEvent('ap/override', { overrideId: humanOverrideId, toolName: request.toolName, ttlMs: options.overrideTtlMs, phase: 'consumed' }, kernel.clock.now(), kernel.rng),
      )
    }

    // Run the read-only reviewer with a timeout race.
    const verdictId = `v_${kernel.clock.now().toString(36)}_${(kernel.rng).token()}`
    const promptCtx: ReviewRequestContext = {
      sessionId: request.sessionId,
      toolName: request.toolName,
      callId: request.callId,
      approvalReason: request.reason.slice(0, options.reasonMaxChars),
      args: safeParse(request.reason) ?? request.reason,
      riskRules: (options.riskRules ?? []).map(r => ({ pattern: r.pattern, policy: r.policy })),
    }
    if (humanOverrideId !== undefined) promptCtx.humanOverrideId = humanOverrideId
    const prompt = buildReviewPrompt(promptCtx)

    const reviewerSessionTag = `reviewer:${verdictId}`
    adapters.markReviewerSession(reviewerSessionTag)
    try {
      let timedOut = false as boolean
      const timer = setTimeout(() => {
        timedOut = true
      }, Math.max(1000, options.reviewerTimeoutMs))
      let result: { output: unknown; stopReason?: string; model?: string; durationMs: number }
      try {
        result = await adapters.runReviewer(prompt)
      } finally {
        clearTimeout(timer)
      }
      if (timedOut) throw Object.assign(new Error('reviewer-timeout'), { failureKind: 'timeout' })

      const verdict = parseVerdict(result.output, result.stopReason)

      const escalatedToDenial =
        verdict.decision === 'allow' && verdict.riskLevel === 'high' // high risk never auto-allows
      circuit.record(verdict.decision === 'deny' ? 'deny' : 'allow', escalatedToDenial)

      let decision: 'deny' | 'allow' = 'allow'
      if (verdict.decision === 'deny' || escalatedToDenial) decision = 'deny'
      const verdictPayload = {
        verdictId,
        decision,
        riskLevel: verdict.riskLevel,
        ...(result.model !== undefined ? { model: result.model } : {}),
        durationMs: result.durationMs,
      }
      adapters.appendAudit(
        makeAuditEvent('ap/verdict', verdictPayload, kernel.clock.now(), kernel.rng),
      )

      if (verdict.decision === 'deny') {
        feedback.record(request.callId, { verdictId, toolName: request.toolName, reason: verdict.reason, kind: 'deny' })
        adapters.injectToolResultText(
          request.callId,
          `This action was reviewed and denied. ${buildMarker('ap/verdict', verdictId)} Reason: ${verdict.reason}`,
        )
        checkCircuitTrip()
        return 'rejected'
      }
      if (escalatedToDenial) {
        feedback.record(request.callId, { verdictId, toolName: request.toolName, reason: 'high-risk allow overridden by risk policy', kind: 'deny' })
        adapters.injectToolResultText(
          request.callId,
          `Reviewed as high-risk; auto-allow refused. ${buildMarker('ap/verdict', verdictId)}`,
        )
        checkCircuitTrip()
        return 'rejected'
      }
      return 'allowed-once'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const kind: FailureKind =
        (error as { failureKind?: FailureKind }).failureKind ??
        (message === 'reviewer-timeout' ? 'timeout' : 'unavailable')
      const outcome = applyFailure(kind, request, verdictId)
      void reviewerSessionTag
      return outcome
    } finally {
      adapters.unmarkReviewerSession(reviewerSessionTag)
    }
  }

  function applyFailure(kind: FailureKind, request: ApprovalRequestLike2, verdictId?: string): ReviewOutcome {
    // Cancellation is settled cancelled and never burns the failure budget.
    const budgets = kernel.ledger.turn(request.sessionId, request.turnId, options.maxReviewsPerTurn, options.maxFailuresPerTurn)
    budgets.recordFailure(kind)
    if (kind === 'cancelled') {
      if (verdictId !== undefined) {
        adapters.appendAudit(
          makeAuditEvent('ap/verdict', { verdictId, decision: 'deny', fallback: kind }, kernel.clock.now(), kernel.rng),
        )
      }
      return 'cancelled'
    }
    checkCircuitTrip()
    if (options.fallbackPolicy === 'allow-once') return 'allowed-once'
    if (options.fallbackPolicy === 'delegate') return 'delegate'
    // rejected (default)
    const id = verdictId ?? `v_${kernel.clock.now().toString(36)}_${(kernel.rng).token()}`
    feedback.record(request.callId, { verdictId: id, toolName: request.toolName, reason: `reviewer ${kind}`, kind: 'fallback' })
    adapters.injectToolResultText(
      request.callId,
      `The reviewer was unavailable (${kind}); fail-closed policy rejected this action. ${buildMarker('ap/verdict', id)}`,
    )
    adapters.appendAudit(
      makeAuditEvent('ap/verdict', { verdictId: id, decision: 'deny', fallback: kind }, kernel.clock.now(), kernel.rng),
    )
    return 'rejected'
  }

  function checkCircuitTrip(): void {
    if (circuit.isTripped()) {
      adapters.appendAudit(
        makeAuditEvent('ap/circuit', {
          action: circuit.config.action,
          consecutiveDenials: Number(circuit.snapshotToken().split(':')[0] ?? 0),
          windowDenials: circuit.snapshotToken().split(':')[1]?.split('').filter(c => c === '1').length ?? 0,
          windowSize: circuit.config.windowSize,
        }, kernel.clock.now(), kernel.rng),
      )
      kernel.coordinator.setCircuitOpen(true)
    }
  }

  return {
    disposable: true as const,
    handleApprovalRequest,
    approveNext,
    consumeFeedback: (callId: string, isError: boolean) => feedback.consume(callId, isError),
    circuitState: () => circuit.state,
    resetCircuit: () =>{  circuit.reset() },
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}
