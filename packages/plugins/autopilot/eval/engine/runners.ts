/**
 * Module runners: script adapters, replay steps, expose an observation holder
 * for assertions. Each runner drives the REAL module factory.
 */
import { createKernel } from '../../src/kernel/facade.js'
import type { Kernel } from '../../src/kernel/facade.js'
import { createContinueModule } from '../../src/continue/index.js'
import { createGuardModule } from '../../src/guard/index.js'
import { createReviewModule } from '../../src/review/index.js'

export interface RunOutput {
  observed: Record<string, unknown>
  dispose(): void
}

type Timer = { fn: () => void; at: number; cancelled: boolean }

function makeClock() {
  let t = 1_700_000_000_000
  return {
    clock: { now: (): number => t },
    advance(ms: number): void {
      t += ms
    },
    get now(): number {
      return t
    },
  }
}

function makeTimerHost(clock: ReturnType<typeof makeClock>) {
  const timers: Timer[] = []
  return {
    timers,
    setTimeoutMs(fn: () => void, ms: number): () => void {
      const entry = { fn, at: clock.now + ms, cancelled: false }
      timers.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    flush(): void {
      for (const entry of Array.from(timers)) {
        if (!entry.cancelled && entry.at <= clock.now) {
          entry.cancelled = true
          entry.fn()
        }
      }
    },
  }
}

const tokenCounter = (() => {
  let n = 0
  return { token: (): string => `t${(n += 1)}` }
})()

// ---------------------------------------------------------------------------
// continue
// ---------------------------------------------------------------------------

interface ContinueSetup {
  classifyErrors?: boolean
  cooldownMs?: number
  graceMs?: number
  maxConsecutive?: number
  activeSessions?: string[]
  lastTurn?: Record<string, unknown>
}

function runContinue(kernel: Kernel, setup: ContinueSetup, steps: Array<Record<string, unknown>>): RunOutput {
  const clock = makeClock()
  const timerHost = makeTimerHost(clock)
  const sent: Array<{ sessionId: string; template: string }> = []
  const skips: string[] = []

  const mod = createContinueModule({
    kernel,
    options: {
      enabled: true,
      graceMs: setup.graceMs ?? 3000,
      cooldownMs: setup.cooldownMs ?? 20_000,
      maxConsecutive: setup.maxConsecutive ?? 3,
      backoffFactor: 2,
      backoffCapMs: 300_000,
      scanOnBoot: true,
      scanLimit: 8,
      scanWindowMs: 900_000,
      classifyErrors: setup.classifyErrors ?? true,
      texts: undefined,
    } as never,
    adapters: {
      requestResume(sessionId) {
        return kernel.coordinator.dispatch({ kind: 'resume-request', sessionId })
      },
      sendFollowup(sessionId, _text, template) {
        sent.push({ sessionId, template })
        return true
      },
      setTimeoutMs: timerHost.setTimeoutMs,
      auditResumed() {},
      auditSkipped(payload) {
        skips.push(payload.reason)
      },
      listActiveSessionIds: () => setup.activeSessions ?? [],
      getLastTurn: sessionId =>
        setup.lastTurn === undefined ? undefined : ({ reason: 'error', endedAt: clock.now - 1000, ...setup.lastTurn, sessionId } as never),
    },
  })

  for (const step of steps) {
    if (step['turnEnd'] !== undefined) {
      const e = step['turnEnd'] as Record<string, unknown>
      mod.handleTurnEnd(String(e['sessionId'] ?? 's1'), String(e['reason'] ?? 'error') as never, e['failure'] as never)
    } else if (step['turnStart'] !== undefined) {
      mod.handleTurnStart(String(step['turnStart']))
    } else if (step['userMessage'] !== undefined) {
      mod.handleUserMessage(String(step['userMessage']))
    } else if (step['assistantMessage'] !== undefined) {
      mod.handleAssistantMessage(String(step['assistantMessage'] ?? 's1'), String(step['text'] ?? ''))
    } else if (step['advanceMs'] !== undefined) {
      clock.advance(Number(step['advanceMs']))
      timerHost.flush()
    } else if (step['bootScan'] !== undefined) {
      mod.bootScan()
    } else if (step['expectStillDeferred'] !== undefined) {
      // Marker step: nothing to execute; assertions after the next advance
      // window prove the deferred attempt was re-armed rather than dropped.
    } else if (step['pendingApproval'] !== undefined) {
      const p = step['pendingApproval'] as Record<string, unknown>
      kernel.coordinator.dispatch({
        kind: 'approval-pending',
        sessionId: String(p['sessionId'] ?? 's1'),
        callId: String(p['callId'] ?? 'c1'),
        toolName: String(p['toolName'] ?? 'bash'),
      })
    } else if (step['resolvedApproval'] !== undefined) {
      const p = step['resolvedApproval'] as Record<string, unknown>
      kernel.coordinator.dispatch({
        kind: 'approval-resolved',
        sessionId: String(p['sessionId'] ?? 's1'),
        callId: String(p['callId'] ?? 'c1'),
      })
    }
  }

  return {
    observed: { sentCount: sent.length, sentTemplate: sent[0]?.template ?? '', skipsJoined: skips.join(','), skips },
    dispose() {
      /* nothing persistent */
    },
  }
}

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------

interface GuardSetup {
  classifierResponse?: unknown
  classifierThrows?: boolean
  autoSession?: boolean
}

async function runGuard(
  kernel: Kernel,
  setup: GuardSetup,
  steps: Array<Record<string, unknown>>,
): Promise<RunOutput> {
  const decisions: Array<Record<string, unknown>> = []
  const audits: string[] = []
  const guard = createGuardModule({
    kernel,
    options: { enabled: true, classifierTimeoutMs: 5000, classifyFailDenyStreak: 2, snapshotPathLimit: 50_000 },
    adapters: {
      workspaceRoot: () => 'G:\\work\\proj',
      homePath: () => 'C:\\Users\\dev',
      dshHomePath: () => 'C:\\Users\\dev\\.dsh-zdsh',
      fsProbe: () => ({
        lstat: () => undefined,
        listDir: () => [],
        join: (...parts: string[]) => parts.join('\\'),
      }),
      classifierTransport: () => async () => {
        if (setup.classifierThrows) throw new Error('classifier down')
        return setup.classifierResponse ?? { decision: 'deny', reason: 'default deny' }
      },
      provideDirectUserMessages: () => ['please run the tests'],
      humanAsk: async () => 'rejected',
      appendAudit: event => audits.push(`${event.name}:${String((event.data as Record<string, unknown>)['layer'])}/${String((event.data as Record<string, unknown>)['outcome'])}`),
      isAutoSession: () => setup.autoSession ?? true,
    },
  })

  for (const step of steps) {
    if (step['preToolUse'] !== undefined) {
      const s = step['preToolUse'] as Record<string, unknown>
      const shell = s['shell'] as 'bash' | 'pwsh' | undefined
      const base = {
        sessionId: String(s['sessionId'] ?? 's1'),
        callId: String(s['callId'] ?? 'c1'),
        toolName: String(s['toolName'] ?? 'bash'),
        argsJson: typeof s['argsJson'] === 'string' ? (s['argsJson'] as string) : JSON.stringify(s['argsJson']),
      }
      const exec: import('../../src/guard/index.js').PreToolExec =
        shell !== undefined ? { ...base, shell } : base
      const verdict = await guard.handlePreToolUse(exec)
      decisions.push({ decision: verdict.decision, reason: verdict.reason })
    }
  }

  return {
    observed: {
      lastDecision: decisions.at(-1)?.decision ?? '',
      lastReason: decisions.at(-1)?.reason ?? '',
      decisions,
      auditsJoined: audits.join(','),
    },
    dispose() {},
  }
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

interface ReviewSetup {
  reviewer?: unknown
  reviewerFails?: boolean
  policy?: 'ai' | 'human' | 'never'
  pendingApprovalAsked?: boolean
}

async function runReview(
  kernel: Kernel,
  setup: ReviewSetup,
  steps: Array<Record<string, unknown>>,
): Promise<RunOutput> {
  const outcomes: string[] = []
  const injected: string[] = []
  const review = createReviewModule({
    kernel,
    options: {
      enabled: true,
      maxReviewsPerTurn: 10,
      maxFailuresPerTurn: 10,
      fallbackPolicy: 'rejected',
      circuit: { consecutiveDenials: 3, windowSize: 10, windowDenials: 6, action: 'delegate' },
      overrideTtlMs: 300_000,
      reasonMaxChars: 2000,
      reviewerTimeoutMs: 5000,
      defaultPolicy: setup.policy ?? 'ai',
    },
    adapters: {
      sessionEnabled: () => true,
      hasPendingApprovalAsked: () => setup.pendingApprovalAsked ?? true,
      runReviewer: async () => {
        if (setup.reviewerFails) throw new Error('reviewer down')
        return { output: setup.reviewer ?? { decision: 'allow', reason: 'ok', riskLevel: 'low' }, stopReason: 'completed', model: 'mock', durationMs: 5 }
      },
      markReviewerSession: () => {},
      unmarkReviewerSession: () => {},
      isReviewerSession: () => false,
      injectToolResultText: (_callId, text) => injected.push(text),
      appendAudit: () => {},
    },
  })

  for (const step of steps) {
    if (step['approvalRequest'] !== undefined) {
      const r = step['approvalRequest'] as Record<string, unknown>
      const outcome = await review.handleApprovalRequest({
        sessionId: String(r['sessionId'] ?? 's1'),
        agentSessionId: String(r['agentSessionId'] ?? 'agent-1'),
        callId: String(r['callId'] ?? 'call-1'),
        toolName: String(r['toolName'] ?? 'bash'),
        reason: String(r['reason'] ?? 'do a thing'),
        turnId: 'turn-1',
      })
      outcomes.push(outcome)
    }
  }

  return {
    observed: {
      lastOutcome: outcomes.at(-1) ?? '',
      outcomesJoined: outcomes.join(','),
      injectedText: injected.join(' | '),
    },
    dispose() {},
  }
}

// ---------------------------------------------------------------------------

export async function runCase(kase: {
  name: string
  module: string
  setup: Record<string, unknown>
  steps: Array<Record<string, unknown>>
}): Promise<RunOutput> {
  const kernel = createKernel({ rng: tokenCounter })
  switch (kase.module) {
    case 'continue':
      return runContinue(kernel, kase.setup as ContinueSetup, kase.steps)
    case 'guard':
      return await runGuard(kernel, kase.setup as GuardSetup, kase.steps)
    case 'review':
      return await runReview(kernel, kase.setup as ReviewSetup, kase.steps)
    default:
      throw new Error(`unknown module ${kase.module}`)
  }
}
