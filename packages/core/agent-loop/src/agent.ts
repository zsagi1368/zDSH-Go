/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  LlmError,
  TRUNCATED_TOOL_CALL_CODE,
  createAssistantMessage,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-projection'
import {
  accountResetCost,
  createResetLedger,
  deserializeLedger,
  registerResetEvent as registerGuardianResetEvent,
  resolveCacheEconomics,
  serializeLedger,
  type ResetLedger,
} from '@deepseek-ai/dsh-llm-pi-ai/cache-guardian'
import type { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAttempt } from './assistant-stream.ts'
import { RuntimeContextProjection, type DeltaResetSink } from './runtime-context.ts'
import { executeToolCalls } from './tool-calls.ts'

/**
 * L5 重置台账的持久化载体（Phase 6）：每次尾部合并/重置后追加一条
 * log-only 事件，把序列化的 cache-guardian `ResetLedger` 与累计重置写入
 * 成本写入会话日志——事件日志即会话的持久化存储，resume 时回放重建。
 * `ignorable` 语义：它只是辅助台账，不影响消息历史重构，旧版读取器
 * 可以安全跳过（事件本身属于本版已知词汇表，正常读取方照常重建）。
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * L5 缓存重置台账快照（Phase 6 遗留收口）：`tailMerge`/`compaction`
     * 重置登记后追加，序列化 cache-guardian `ResetLedger`（events +
     * generation）与累计重置写入成本。log-only，辅助缓存豁免窗口与
     * 记账重建，不参与消息历史重构。
     */
    'cache/ledger': {
      /** 序列化的重置台账 JSON（`serializeLedger` 输出，快照式，恢复取末条）。 */
      ledger: string
      /**
       * 本次重置的增量写入成本（token 当量，`η×contextTokens`，即
       * `accountResetCost` 单条结果）。非累计快照——投影侧 `cacheMetrics`
       * 经 `foldResetWriteCost` 逐条累加成 `resetWriteTokens`，agent 侧
       * `restoreCacheLedger` 对所有条求和还原 `totalResetWriteCost`，两者
       * 恒等于同一 Σ，故报告指标与持久化账本不会分叉。
       */
      resetWriteCost: number
    }
  }
}

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    startsRequestSeries?: true
    assembly: PromptAssembly
  }

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/**
 * openai-completions 系路由名单（D1 接线：保守判定 `deferFoldAfterToolResult`）。
 *
 * 背景（M4′ 闭合 a）：pi-ai 的 `requiresAssistantAfterToolResult` 垫片——在
 * toolResult 与其后 user 消息之间注入占位 assistant——只对 `openai-completions`
 * 协议有意义，且**默认禁用**：`detectCompat` 对所有 provider 返回 false，DSH 的
 * llm-pi-ai catalog 仅把它列为 profile 可配置项（`'offer'`），未对任何路由默认
 * 启用。这类路由对 wire 上的 `[toolResult, user(delta)]` 相邻对可能 400/误读，
 * 故 L2 delta 折叠需推迟（`deferFoldAfterToolResult=true`：delta 保持 pending，
 * 不丢，等下一条真实 user 前有 assistant 中介，或由压缩边界回收）。
 *
 * 判定局限：agent-loop 侧只拿得到 provider 路由字符串——`LlmCallConfig` 不携带
 * 已解析的 wire 协议，pi-ai 的 compat 垫片状态也不向本包暴露（见 runtime-context
 * 的 `deferFoldAfterToolResult` 选项注释）。故此处按「路由名恰为已知
 * openai-completions 系内建 provider」保守匹配。名单取自 pi-ai 内建 provider 中
 * **默认协议即 openai-completions** 者（deepseek/groq/cerebras/openrouter/… 及
 * 若干国产 openai-compatible 路由）；按 provider id 小写形态收录。
 *
 * 名单外一律返回 false（不误伤）：自定义网关名、anthropic-messages /
 * openai-responses 系、混合按模型分派协议者（xai）、以及空/未知 provider，都
 * 保持缺省折叠。误判方向是安全的——误置 true 只是把折叠推迟到下一条 assistant
 * 中介之后（delta 绝不丢），误置 false 才会漏出 `[toolResult, user]` 相邻对；
 * 因此对「名字命中已知 openai-completions 路由」者宁可推迟。
 *
 * 长期更干净方案：在 llm-pi-ai catalog 对 openai-completions 系路由默认启用
 * `requiresAssistantAfterToolResult` 垫片（wire 上自动补占位 assistant），届时
 * 撤销本接线（连同名单），恢复工具批末即时折叠。
 */
const OPENAI_COMPLETIONS_FAMILY_PROVIDERS: ReadonlySet<string> = new Set([
  'deepseek',
  'groq',
  'cerebras',
  'openrouter',
  'huggingface',
  'together',
  'nvidia',
  'moonshotai',
  'moonshotai-cn',
  'zai',
  'zai-coding-cn',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'xiaomi',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-sgp',
  'ant-ling',
  'cloudflare-workers-ai',
])

/**
 * 是否对某 provider 路由推迟工具批末折叠（D1 接线判定）。见
 * {@link OPENAI_COMPLETIONS_FAMILY_PROVIDERS} 的名单与局限说明。
 * @param provider - 构造期可解析的 provider 路由字符串（会话已解析路由优先，
 *   否则声明路由；见 {@link ReactLoopAgent.cacheProvider}）。
 * @returns 命中 openai-completions 系名单时 true，否则 false（缺省，不误伤）。
 */
function shouldDeferFoldAfterToolResult(provider: string): boolean {
  const normalized = provider.trim().toLowerCase()
  if (normalized.length === 0) return false
  return OPENAI_COMPLETIONS_FAMILY_PROVIDERS.has(normalized)
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  /** Surface generation of the preceding built request. */
  private requestSurfaceGeneration: number | undefined
  private readonly runtimeContext: RuntimeContextProjection
  /** Process-local revision of assistant frames for this attached Session. */
  private assistantStreamRevision = 0
  private assistantAttemptCounter = 0
  /** L5 重置事件台账（cache-guardian `ResetLedger`），resume 时从会话日志重建。 */
  private cacheLedger: ResetLedger
  /**
   * 累计重置写入成本（token 当量，Σ η×contextTokens）。它是各 `cache/ledger`
   * 事件增量 `resetWriteCost` 的运行期求和，与 token-meter 投影经
   * `foldResetWriteCost` 累加出的 `resetWriteTokens` 恒等（同一批事件、同一
   * 增量），resume 时由 `restoreCacheLedger` 从日志重算还原。
   */
  private totalResetWriteCost = 0

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    /* v8 ignore next -- the loop registers its own turnBoundary unit, so the key is always present */
    const lastTurn = this.loopCtx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    // L2↔L5 重置事件桥：RuntimeContextProjection 的 DeltaResetSink 登记
    // tailMerge/compaction 时，映射为 cache-guardian 白名单事件并入台账，
    // 按当前会话 provider 的 η 记账 `η×contextTokens`，随后把台账写入
    // 会话日志（`cache/ledger` 事件，resume 时回放重建）。
    this.cacheLedger = this.restoreCacheLedger()
    const resetSink: DeltaResetSink = {
      registerResetEvent: (type, seq, contextTokens) => {
        // L5 白名单映射：tailMerge（尾部合并）→ mergeRewrite（合并重写）；
        // compaction 直接对应白名单的 compaction。
        const mappedType = type === 'tailMerge' ? 'mergeRewrite' : type
        this.cacheLedger = registerGuardianResetEvent(this.cacheLedger, mappedType, seq)
        // 单条重置写入成本（η×context）：既累加进本 agent 的 totalResetWriteCost，
        // 又作为增量随 `cache/ledger` 事件持久化——投影侧对同一事件经
        // `foldResetWriteCost` 累加，两条账共用同一份增量，恒等。
        let resetWriteCost = 0
        if (contextTokens !== undefined) {
          const eta = resolveCacheEconomics(this.cacheProvider()).eta
          resetWriteCost = accountResetCost(contextTokens, eta)
          this.totalResetWriteCost += resetWriteCost
        }
        this.persistCacheLedger(resetWriteCost)
      },
    }
    // D1 接线：openai-completions 系路由（DeepSeek 等，`requiresAssistantAfterToolResult`
    // 垫片默认禁用）推迟工具批末折叠，避免 wire 上出现 `[toolResult, user(delta)]`
    // 相邻对触发 provider 400/误读。此处按构造期可解析的 provider 路由置**初值**；
    // provider 可在会话中途切换，故 `buildRequest` 每次按已解析的 `config.provider`
    // 重算并更新（见 {@link shouldDeferFoldAfterToolResult} 与 runtime-context 的
    // `setDeferFoldAfterToolResult`）。名单外/未知一律 false，不误伤。
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session, {
      resetSink,
      deferFoldAfterToolResult: shouldDeferFoldAfterToolResult(this.cacheProvider()),
    })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** 当前会话 provider 路由（η 解析用）：优先会话内已解析的路由元数据。 */
  private cacheProvider(): string {
    return this.session.requestContext()?.provider ?? this.options.provider ?? ''
  }

  /**
   * 从会话日志回放重建 L5 台账。两条账分别处理，保证与 token-meter 投影恒等：
   * - 成本 `totalResetWriteCost`：对**所有** `cache/ledger` 事件的增量
   *   `resetWriteCost` 求和——投影侧 `foldResetWriteCost` 逐条累加的是同一批
   *   事件，故 resume 后两视图必然相等（与 ledger JSON 是否可解析无关）。
   * - 台账快照 `ResetLedger`：取末条可反序列化的 `ledger`；损坏的 JSON 视为
   *   不存在（重建空台账）；无事件时同样返回空台账。
   */
  private restoreCacheLedger(): ResetLedger {
    const events = this.session.snapshotEvents()
    let total = 0
    for (const event of events) {
      if (event.type === 'cache/ledger') total += event.data.resetWriteCost
    }
    this.totalResetWriteCost = total
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'cache/ledger') continue
      const ledger = deserializeLedger(event.data.ledger)
      if (ledger === undefined) break
      return ledger
    }
    return createResetLedger()
  }

  /**
   * 把当前台账快照与**本次重置的增量写入成本**序列化进会话日志（log-only 事件）。
   * `resetWriteCost` 是单条增量（非累计），投影与恢复据此各自累加/求和成同一 Σ。
   */
  private persistCacheLedger(resetWriteCost: number): void {
    this.session.append('cache/ledger', {
      ledger: serializeLedger(this.cacheLedger),
      resetWriteCost,
    })
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    // L2 delta 内部登记：状态变化只登记增量文本，不产生完整快照 user 消息。
    const sections = renderContextSections(assembly)
    this.runtimeContext.register(joinContextSections(sections), sections)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: claimed,
      }),
    )
    signal.throwIfAborted()
    if (decision.kind === 'reject') return decision
    // L2 出站折叠：delta 折进下一条真实 user 消息的文本前缀（wire 上
    // 不存在孤立 user(delta)）；preflight 不通过时推迟到下次。
    return { ...decision, assembly, messages: this.runtimeContext.foldInto(decision.messages) }
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          // max-tokens is sticky: once any step hits the ceiling, later steps
          // that complete normally must not downgrade the turn outcome.
          const stepEnd = await this.step(decision.assembly, decision.startsRequestSeries === true)
          // max-tokens stays sticky: a later completed step must not
          // downgrade the turn outcome.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(assembly: PromptAssembly, startsRequestSeries: boolean): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    const system = renderPrompt(assembly)

    while (true) {
      const surfaceGeneration = this.session.surface.replaceGeneration
      const { request, preparedCall } = await this.buildRequest(
        turn,
        step,
        assembly.tools,
        system,
        this.session.deriveMessages(),
        startsRequestSeries,
        surfaceGeneration,
        signal,
      )
      startsRequestSeries = false
      const live = new AssistantStreamAttempt(
        this.session.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        turn,
        step,
        (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
      )
      let started = false
      try {
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        live.start()
        started = true
        for await (const chunk of stream) {
          signal.throwIfAborted()
          live.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (!started) throw error
        try {
          if (signal.aborted) {
            const content = live.interruptedBlocks()
            if (content.length > 0) {
              live.settle('assistant/message', () => this.session.append('assistant/message', {
                turn,
                step,
                message: createAssistantMessage({
                  content,
                  source: {
                    provider: request.provider,
                    model: request.model,
                    ...live.replayState === undefined ? {} : { replayState: live.replayState },
                  },
                }),
                interrupted: true,
                ...live.usage === undefined ? {} : { usage: live.usage },
                stream: live.stream,
              }, { surfaceOp: 'append' }).seq)
            } else {
              live.settle(
                'assistant/attempt',
                () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
              )
            }
          } else {
            live.settle(
              'assistant/attempt',
              () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
            )
          }
        } catch (settlementError: unknown) {
          throw new AggregateError(
            [error, settlementError],
            'Assistant stream failed and its durable settlement was rejected',
            { cause: error },
          )
        }
        throw error
      }
      try {
        const finish = live.finish
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          live.settle(
            'assistant/attempt',
            () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
          )
          const action = await this.dispatch.waterfall(
            'agent/request-error', {
              turn,
              step,
              provider: request.provider,
              failure: finish.failure,
              retryPolicy: preparedCall?.retryPolicy,
              signal,
            },
            () => Promise.resolve<RequestErrorAction>(undefined),
          )
          signal.throwIfAborted()
          if (action?.kind !== 'retry') {
            throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
          }
          continue
        }

        const message = createAssistantMessage({
          content: live.blocks(),
          source: {
            provider: request.provider,
            model: request.model,
            ...live.replayState !== undefined ? { replayState: live.replayState } : {},
          },
        })
        live.settle(
          'assistant/message',
          () => this.session.append('assistant/message', {
            turn,
            step,
            message,
            ...live.usage === undefined ? {} : { usage: live.usage },
            stream: live.stream,
          }, { surfaceOp: 'append' }).seq,
        )
        if (finish.kind === 'max-tokens') {
          // A cut-off that reached an unsafe tool call must fail loudly. The
          // assembler drops the call from durable content and reports it only
          // when it never received a block-end close or its arguments are not
          // valid JSON — either way executing it is impossible. A closed tool
          // call with parseable arguments is a complete call and ends the turn
          // cleanly even though it is still dropped from durable content.
          const truncated = live.truncatedToolCalls()
          if (truncated.length > 0) {
            throw new LlmError(
              'the response hit the output-token ceiling while producing '
              + `${truncated.length} tool call${truncated.length === 1 ? '' : 's'};`
              + ' raise maxTokens or continue manually',
              TRUNCATED_TOOL_CALL_CODE,
            )
          }
          return { kind: 'max-tokens' }
        }

        const toolCalls = message.content.filter(block => block.type === 'tool-call')
        if (toolCalls.length === 0) return { kind: 'completed' }
        const { concluded } = await executeToolCalls(
          this.loopCtx, turn, step, toolCalls, signal,
          context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
        )
        return concluded ? { kind: 'completed' } : null
      } catch (error: unknown) {
        if (!live.ended) live.abandon()
        throw error
      }
    }
  }

  /**
   * Compose one frozen request and bind it to the adapter registration that
   * resolved its exact-model defaults.
   */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    boundaryMessages: Message[],
    startsRequestSeries: boolean,
    surfaceGeneration: number,
    signal: AbortSignal,
  ): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance starts from its declared route, restoring only an explicit
    // effort owned by that exact model. Later steps re-resolve marked defaults.
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const persistedReasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()

    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    const startsSeries = startsRequestSeries
      || this.requestSurfaceGeneration !== surfaceGeneration
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', {
        header,
        reason: 'change',
        ...startsSeries ? { startsSeries: true } : {},
      })
    } else if (startsSeries) {
      this.session.append('request/header', { header, reason: 'series' })
    }
    this.requestSurfaceGeneration = surfaceGeneration

    const contextWindow = preparedCall?.context?.contextWindow
    // L2 delta 阈值按上下文窗口缩放（§1.2）：max(8192, floor(W×0.008))。
    // 窗口在请求解析时才确定，故在此应用；未解析到窗口时保持构造默认值。
    if (contextWindow !== undefined) {
      this.runtimeContext.setDeltaThreshold(Math.max(8192, Math.floor(contextWindow * 0.008)))
    }
    // D1 接线（运行期重算）：折叠延迟开关按**本次已解析的实际路由** `config.provider`
    // 重算，而非沿用构造期初值——provider 可经 `agent/request` 瀑布流在会话中途切换
    // （如降级到 openai-completions 系），固定初值会漏出 `[toolResult, user(delta)]`
    // 相邻对触发 400。名单外/未知一律 false，与构造期判定同一套 {@link
    // shouldDeferFoldAfterToolResult}。
    this.runtimeContext.setDeferFoldAfterToolResult(shouldDeferFoldAfterToolResult(config.provider))
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }
}
