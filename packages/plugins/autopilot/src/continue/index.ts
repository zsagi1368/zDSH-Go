/**
 * Continue module — auto-resume after non-human interruptions.
 *
 * Composition root contract (see facade): `createContinueModule(deps)` returns
 * a Disposable plus the session-event handlers the host adapter forwards.
 */
import type { BackoffParams, Clock, RandomSource } from '../kernel/ledger.js'
import type { Kernel } from '../kernel/facade.js'
import { detectBootScan, detectLive } from './detector.js'
import type { FailureInfo } from './detector.js'
import { LOOP_GUARD_DEFAULTS, LoopGuard } from './loopguard.js'
import type { LoopGuardThresholds } from './loopguard.js'
import type { SchedulerAdapters } from './scheduler.js'
import { ContinueScheduler } from './scheduler.js'
import { buildResumeText } from './resumetext.js'
import type { GuardTexts, TemplateContext } from './resumetext.js'

export const DEFAULT_TEXTS = {
  continue: 'Continue',
  continueMaxTokens: 'Continue',
  loop: 'You appear stuck in a loop ({tool}). Change approach or ask me.',
  guardPending: 'Note: the previous {tool} call may not have finished — check its result before redoing it.',
  guardDone: 'Note: the previous {tool} call already completed successfully — do NOT redo it, continue from its result.',
} as const

export interface ContinueTexts {
  continue: string
  continueMaxTokens: string
  loop: string
  guardPending?: string
  guardDone?: string
}

export interface ContinueModuleAdapters extends SchedulerAdapters {
  /** Feed assistant/tool activity into the loop guard (host event adapter). */
  listActiveSessionIds(): string[]
  getLastTurn(sessionId: string): {
    reason: string
    endedAt: number
    failure?: FailureInfo
    lastTool?: { name: string; state: 'pending' | 'done' | 'failed' }
  } | undefined
}

export interface CreateContinueModuleDeps {
  kernel: Kernel
  options: {
    enabled: boolean
    graceMs: number
    cooldownMs: number
    maxConsecutive: number
    backoffFactor: number
    backoffCapMs: number
    scanOnBoot: boolean
    scanLimit: number
    scanWindowMs: number
    classifyErrors: boolean
    loopGuard?: Partial<LoopGuardThresholds>
    texts?: Partial<ContinueTexts>
  }
  adapters: ContinueModuleAdapters
}

export interface ContinueModule {
  handleTurnStart(sessionId: string): void
  handleTurnEnd(
    sessionId: string,
    reason: 'completed' | 'error' | 'max-tokens' | 'aborted' | 'blocked',
    failure?: FailureInfo,
  ): void
  handleUserMessage(sessionId: string): void
  handleAssistantMessage(sessionId: string, text: string): void
  handleToolCall(sessionId: string, toolName: string, argsJson: string): void
  noteRecoveredTurn(sessionId: string): void
  handleToolResult(
    sessionId: string,
    toolName: string,
    argsJson: string,
    resultJson: string,
    isError: boolean,
  ): void
  bootScan(): void
  pauseSession(sessionId: string, durationMs?: number): void
  resumeSession(sessionId: string): void
  resumeNow(sessionId: string): boolean
}

export function createContinueModule(deps: CreateContinueModuleDeps): ContinueModule & { disposable: true } {
  const { kernel, adapters } = deps
  const options = deps.options
  const texts: ContinueTexts = { ...DEFAULT_TEXTS, ...options.texts }
  const backoff: BackoffParams = {
    baseMs: options.cooldownMs,
    factor: options.backoffFactor,
    capMs: options.backoffCapMs,
  }
  const clock: Clock = kernel.clock
  const rng: RandomSource = kernel.rng

  const guards = new Map<string, LoopGuard>()
  const pendingFailure = new Map<string, { failure?: FailureInfo; endedAt: number }>()

  function guardFor(sessionId: string): LoopGuard {
    let guard = guards.get(sessionId)
    if (!guard) {
      guard = new LoopGuard(
        { ...LOOP_GUARD_DEFAULTS, ...options.loopGuard },
        () => clock.now(),
      )
      guards.set(sessionId, guard)
    }
    return guard
  }

  const scheduler = new ContinueScheduler(
    adapters,
    clock,
    rng,
    { session: _id => kernel.ledger.session(_id, backoff) },
    backoff,
    { graceMs: options.graceMs, maxConsecutive: options.maxConsecutive },
  )

  function scheduleResume(
    sessionId: string,
    kind: 'continue' | 'continue-max-tokens',
  ): void {
    const info = pendingFailure.get(sessionId)
    const failure = info?.failure
    scheduler.schedule(sessionId, kind, () => {
      const ctx: TemplateContext = {}
      if (failure?.code !== undefined) ctx.code = failure.code
      if (failure?.message !== undefined) ctx.message = failure.message
      if (failure?.status !== undefined) ctx.status = String(failure.status)
      if (info) ctx.elapsedMs = clock.now() - info.endedAt
      const guardTexts: GuardTexts = {}
      if (texts.guardPending !== undefined) guardTexts.pending = texts.guardPending
      if (texts.guardDone !== undefined) guardTexts.done = texts.guardDone
      return buildResumeText({
        kind,
        texts,
        ctx,
        guards: guardTexts,
      })
    })
  }

  return {
    disposable: true,

    handleTurnStart(sessionId) {
      if (!options.enabled) return
      guardFor(sessionId).beginTurn()
      scheduler.beginTurn(sessionId)
    },

    handleTurnEnd(sessionId, reason, failure) {
      if (!options.enabled) return
      const verdict = detectLive(reason, failure ?? undefined, {
        classifyErrors: options.classifyErrors,
      })
      if (verdict.action === 'skip') {
        if (verdict.skipReason === 'permanent-failure') {
          adapters.auditSkipped({ sessionId, reason: 'permanent-failure' })
        }
        return
      }
      pendingFailure.set(sessionId, {
        ...(failure ? { failure } : {}),
        endedAt: clock.now(),
      })
      scheduleResume(sessionId, reason === 'max-tokens' ? 'continue-max-tokens' : 'continue')
    },

    handleUserMessage(sessionId) {
      pendingFailure.delete(sessionId)
      scheduler.noteUserMessage(sessionId)
    },

    handleAssistantMessage(sessionId, text) {
      if (!options.enabled) return
      const guard = guardFor(sessionId)
      guard.feedAssistant(text)
      if (guard.shouldInterrupt()) {
        guard.markFired()
        // Interrupt + restart goes through the same gates as any send.
        scheduler.schedule(sessionId, 'continue', () =>
          buildResumeText({
            kind: 'loop',
            texts,
            ctx: {},
            guards: {},
          }),
        )
      }
    },

    handleToolCall(sessionId, toolName, argsJson) {
      if (!options.enabled) return
      guardFor(sessionId) // ensure the guard exists for the turn
      void toolName
      void argsJson
    },

    handleToolResult(sessionId, toolName, argsJson, resultJson, isError) {
      if (!options.enabled) return
      const guard = guardFor(sessionId)
      if (!isError) guard.feedTool(toolName, argsJson, resultJson)
    },

    noteRecoveredTurn(sessionId) {
      scheduler.noteRecoveredTurn(sessionId)
    },

    bootScan() {
      if (!options.enabled || !options.scanOnBoot) return
      const now = clock.now()
      let scanned = 0
      for (const sessionId of adapters.listActiveSessionIds()) {
        if (scanned >= options.scanLimit) break
        const last = adapters.getLastTurn(sessionId)
        if (!last) continue
        scanned += 1
        if (now - last.endedAt > options.scanWindowMs) continue
        const verdict = detectBootScan(last.reason as never, last.failure, {
          classifyErrors: options.classifyErrors,
        })
        if (verdict.action !== 'skip') {
          pendingFailure.set(sessionId, {
            ...(last.failure ? { failure: last.failure } : {}),
            endedAt: last.endedAt,
          })
          scheduleResume(sessionId, 'continue')
        }
      }
    },

    pauseSession(sessionId, durationMs = 3_600_000) {
      scheduler.pauseSession(sessionId, durationMs)
    },

    resumeSession(sessionId) {
      scheduler.resumeSession(sessionId)
    },

    resumeNow(sessionId) {
      // Explicit human action: bypasses cooldowns and limits by definition.
      return scheduler.resumeNow(sessionId, texts.continue)
    },
  }
}
