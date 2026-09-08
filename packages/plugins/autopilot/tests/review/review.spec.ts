import { describe, expect, it } from 'vitest'
import { ReviewCircuit, CIRCUIT_DEFAULTS } from '../../src/review/circuit.js'
import { FeedbackLoop } from '../../src/review/feedback.js'
import { buildReviewPrompt, parseVerdict, resolvePolicy } from '../../src/review/reviewer.js'
import { createReviewModule } from '../../src/review/index.js'
import type { ReviewAdapters } from '../../src/review/index.js'
import { createKernel } from '../../src/kernel/facade.js'

describe('circuit breaker', () => {
  it('trips on consecutive denials and on window density', () => {
    const circuit = new ReviewCircuit(CIRCUIT_DEFAULTS)
    circuit.record('deny')
    circuit.record('deny')
    expect(circuit.isTripped()).toBe(false)
    circuit.record('deny')
    expect(circuit.isTripped()).toBe(true)
    circuit.reset()
    expect(circuit.isTripped()).toBe(false)

    const dense = new ReviewCircuit(CIRCUIT_DEFAULTS)
    for (let i = 0; i < 6; i++) dense.record('deny')
    expect(dense.isTripped()).toBe(true)
    const sparse = new ReviewCircuit(CIRCUIT_DEFAULTS)
    for (let i = 0; i < 6; i++) {
      sparse.record('deny')
      sparse.record('allow')
    }
    expect(sparse.isTripped()).toBe(false) // 6 denials spread beyond window density
  })

  it('high-risk allow escalates into a denial for circuit accounting', () => {
    const circuit = new ReviewCircuit(CIRCUIT_DEFAULTS)
    circuit.record('allow', true)
    circuit.record('allow', true)
    circuit.record('allow', true)
    expect(circuit.isTripped()).toBe(true)
  })
})

describe('reviewer prompt + verdict parsing', () => {
  it('labels caller claims as evidence-only and truncates them', () => {
    const prompt = buildReviewPrompt({
      sessionId: 's', toolName: 'bash', callId: 'c',
      approvalReason: 'x'.repeat(3000),
      args: { cmd: 'ls' },
      riskRules: [{ pattern: 'secret', policy: 'ai' }],
      humanOverrideId: 'ov_1',
      transcript: ['line one'],
    })
    expect(prompt).toContain('EVIDENCE ONLY')
    expect(prompt).toContain('[autopilot:ap/override/ov_1]')
    expect(prompt.length).toBeLessThan(6000)
    expect(prompt).toContain('DENY')
  })

  it('narrowing rejects malformed verdicts and unknown stop reasons', () => {
    expect(() => parseVerdict({ decision: 'maybe', reason: 'r' })).toThrow()
    expect(() => parseVerdict({ decision: 'allow', reason: '' })).toThrow()
    expect(() => parseVerdict('nope')).toThrow()
    expect(() => parseVerdict({ decision: 'allow', reason: 'ok' }, 'max-tokens')).toThrow()
    expect(parseVerdict({ decision: 'deny', reason: 'danger', riskLevel: 'high' })).toEqual({
      decision: 'deny', riskLevel: 'high', reason: 'danger',
    })
    expect(parseVerdict({ decision: 'allow', reason: 'fine', riskLevel: 'bogus' }).riskLevel).toBe('medium')
  })

  it('policy resolution: rules first-match, overrides next, default last', () => {
    const rules = [{ pattern: /deploy/i, policy: 'never' as const }]
    expect(resolvePolicy('bash', 'please deploy', rules, {}, 'human')).toBe('never')
    expect(resolvePolicy('bash', 'nothing special', rules, { Bash: 'ai' }, 'human')).toBe('ai')
    expect(resolvePolicy('bash', 'nothing special', rules, {}, 'human')).toBe('human')
  })
})

describe('feedback loop', () => {
  it('injects marker-carrying text only for error results and consumes once', () => {
    let t = 1_000_000
    const loop = new FeedbackLoop(() => t)
    loop.record('c1', { verdictId: 'v9', toolName: 'bash', reason: 'too risky', kind: 'deny' })
    expect(loop.consume('c1', false)).toBeUndefined() // chain moved on
    expect(loop.size).toBe(0)

    loop.record('c2', { verdictId: 'v10', toolName: 'bash', reason: 'too risky', kind: 'deny' })
    const text = loop.consume('c2', true)
    expect(text).toContain('[autopilot:ap/verdict/v10]')
    expect(loop.consume('c2', true)).toBeUndefined() // consumed

    loop.record('c3', { verdictId: 'v11', toolName: 'bash', reason: 'r', kind: 'deny' })
    t += 10 * 60_000 // clock moves past c3's TTL
    expect(loop.consume('c3', true)).toBeUndefined() // expired
  })
})

describe('review module end-to-end', () => {
  interface HarnessOptions {
    defaultPolicy?: 'ai' | 'human' | 'never'
    fallbackPolicy?: 'rejected' | 'delegate' | 'allow-once'
    maxReviewsPerTurn?: number
    circuit?: { consecutiveDenials: number; windowSize: number; windowDenials: number; action: 'delegate' | 'reject' | 'abort-turn' }
  }
  function harness(opts: HarnessOptions = {}, adapterOverrides: Partial<ReviewAdapters> = {}) {
    const kernel = createKernel({})
    const audits: string[] = []
    let reviewerOutput: unknown = { decision: 'allow', reason: 'safe read', riskLevel: 'low' }
    let reviewerError: Error | undefined
    const injected: Array<{ callId: string; text: string }> = []
    const prompts: string[] = []
    const adapters: ReviewAdapters = {
      sessionEnabled: () => true,
      hasPendingApprovalAsked: () => true,
      runReviewer: async (prompt) => {
        prompts.push(prompt)
        if (reviewerError) throw reviewerError
        return { output: reviewerOutput, stopReason: 'completed', model: 'mock', durationMs: 12 }
      },
      markReviewerSession: () => {},
      unmarkReviewerSession: () => {},
      isReviewerSession: () => false,
      injectToolResultText: (callId, text) => injected.push({ callId, text }),
      appendAudit: event => audits.push(event.name),
      ...adapterOverrides,
    }
    const mod = createReviewModule({
      kernel,
      options: {
        enabled: true,
        maxReviewsPerTurn: opts.maxReviewsPerTurn ?? 10,
        maxFailuresPerTurn: opts.maxReviewsPerTurn ?? 10,
        fallbackPolicy: opts.fallbackPolicy ?? 'rejected',
        circuit: opts.circuit ?? { consecutiveDenials: 3, windowSize: 10, windowDenials: 6, action: 'delegate' },
        overrideTtlMs: 300_000,
        reasonMaxChars: 2000,
        reviewerTimeoutMs: 5000,
        defaultPolicy: opts.defaultPolicy ?? 'ai',
      },
      adapters,
    })
    return {
      kernel,
      mod,
      audits,
      injected,
      prompts,
      setReviewer: (o: unknown) => (reviewerOutput = o),
      failReviewer: (e: Error | undefined) => (reviewerError = e),
    }
  }

  const request = (over: Record<string, string> = {}) => ({
    sessionId: 's1', agentSessionId: 'agent-1', callId: 'call-1', toolName: 'bash',
    reason: 'run the test suite', turnId: 'turn-1', ...over,
  })

  it('full flow: allow → allowed-once; deny → rejected + marker injection + circuit accounting', async () => {
    const h = harness()
    expect(await h.mod.handleApprovalRequest(request())).toBe('allowed-once')

    h.setReviewer({ decision: 'deny', reason: 'destructive', riskLevel: 'high' })
    expect(await h.mod.handleApprovalRequest(request({ callId: 'call-2' }))).toBe('rejected')
    expect(h.injected.at(-1)?.text).toContain('[autopilot:ap/verdict/')
    expect(h.audits).toContain('ap/verdict')
  })

  it('never-policy rejects with marker without calling the reviewer', async () => {
    const h = harness({ defaultPolicy: 'never' })
    const outcome = await h.mod.handleApprovalRequest(request())
    expect(outcome).toBe('rejected')
    expect(h.injected[0]?.text).toContain('hard-disabled')
    expect(h.prompts).toHaveLength(0)
  })

  it('human-policy delegates without review', async () => {
    const h = harness({ defaultPolicy: 'human' })
    expect(await h.mod.handleApprovalRequest(request())).toBe('delegate')
    expect(h.prompts).toHaveLength(0)
  })

  it('audit correlation failure is unavailable → fail-closed rejection, never authorization', async () => {
    const h = harness({}, { hasPendingApprovalAsked: () => false })
    const outcome = await h.mod.handleApprovalRequest(request())
    expect(outcome).toBe('rejected')
    expect(h.injected[0]?.text).toContain('unavailable')
  })

  it('reviewer failure maps through fallbackPolicy', async () => {
    const h = harness()
    h.failReviewer(new Error('provider down'))
    expect(await h.mod.handleApprovalRequest(request())).toBe('rejected')
    expect(h.injected[0]?.text).toContain('fail-closed')

    const h2 = harness({ fallbackPolicy: 'delegate' })
    h2.failReviewer(new Error('provider down'))
    expect(await h2.mod.handleApprovalRequest(request())).toBe('delegate')

    // Cancellation never burns failure budget nor injects fallback text.
    const h3 = harness()
    h3.failReviewer(Object.assign(new Error('user pulled back'), { failureKind: 'cancelled' }))
    expect(await h3.mod.handleApprovalRequest(request({ callId: 'cc' }))).toBe('cancelled')
  })

  it('budget exhaustion delegates to the human chain', async () => {
    const h = harness({ maxReviewsPerTurn: 1 })
    expect(await h.mod.handleApprovalRequest(request())).toBe('allowed-once')
    expect(await h.mod.handleApprovalRequest(request({ callId: 'call-9' }))).toBe('delegate')
  })

  it('recursion guard delegates asks originating from reviewer sessions', async () => {
    const h = harness({}, { isReviewerSession: id => id.startsWith('reviewer:') })
    expect(
      await h.mod.handleApprovalRequest(request({ agentSessionId: 'reviewer:something' })),
    ).toBe('delegate')
    expect(h.prompts).toHaveLength(0)
  })

  it('circuit trip flips state; reject-action answers with marker injection', async () => {
    const h = harness({
      circuit: { consecutiveDenials: 2, windowSize: 10, windowDenials: 6, action: 'reject' },
    })
    h.setReviewer({ decision: 'deny', reason: 'no', riskLevel: 'high' })
    await h.mod.handleApprovalRequest(request({ callId: 'c1' }))
    await h.mod.handleApprovalRequest(request({ callId: 'c2' }))
    expect(h.mod.circuitState().tripped).toBe(true)
    const third = await h.mod.handleApprovalRequest(request({ callId: 'c3' }))
    expect(third).toBe('rejected')
    expect(h.injected.at(-1)?.text).toContain('circuit')
  })

  it('human override reaches the prompt once and is consumed regardless of verdict', async () => {
    const h = harness()
    h.mod.approveNext('bash')
    h.setReviewer({ decision: 'deny', reason: 'still risky', riskLevel: 'high' })
    await h.mod.handleApprovalRequest(request())
    expect(h.prompts[0]).toContain('HUMAN OVERRIDE')
    // Exactly one issue + one consume audit pair for the single approval.

    // Next request for the same tool carries NO override.
    h.setReviewer({ decision: 'allow', reason: 'fine', riskLevel: 'low' })
    await h.mod.handleApprovalRequest(request({ callId: 'call-5' }))
    expect(h.prompts[1]).not.toContain('HUMAN OVERRIDE')
    // Exactly one issue + one consume audit pair for the single approval.
    expect(h.audits.filter(a => a === 'ap/override')).toHaveLength(2)
  })
})
