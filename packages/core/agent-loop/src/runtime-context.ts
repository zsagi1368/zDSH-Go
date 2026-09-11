/**
 * L2 追加历史层：运行时上下文的 delta 投影；并承载 V3 的系统提示投影。
 *
 * 状态变化只登记增量文本（delta），不产生完整快照 user 消息；出站时把
 * delta 折进下一条真实 user 消息的文本前缀（wire 上不存在孤立 user(delta)）。
 * preflight 校验出站序列的协议交替强约束；delta 积压超阈值触发尾部合并并
 * 登记重置事件；压缩边界回收未展示的 delta（并入摘要，随边界从发送视图消失）。
 *
 * 系统提示（{@link SystemPromptProjection}）由上游 V3 引入：以 surface node 0
 * 表示系统头，按路由能力与请求序列决定追加/替换提交，与 L2 的运行时上下文
 * delta 投影互不重叠。
 *
 * @module @deepseek-ai/dsh-agent-loop/runtime-context
 * @see CONTEXT-CACHE-MANAGEMENT.md §2 L2 — 追加历史层（v2.3 M4′ 三项闭合）
 */

import { createSystemMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextSnapshotSection, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SurfaceIntent, SystemMessage } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

const SOURCE = '@deepseek-ai/dsh-system-prompt'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'
const DELTA_SEPARATOR = '\n\n'
/**
 * 子串启发式的最小匹配长度：工具结果覆盖判定与折叠前缀识别都基于子串匹配，
 * 短文本（< 本值）容易恰好命中无关联工具输出或用户消息的自然分段，造成误报；
 * 低于该长度一律不做覆盖判定 / 不识别为折叠前缀（保守：宁多登记，不静默丢变更）。
 */
const MIN_MATCH_TEXT_LENGTH = 8

/**
 * §1.2：delta 阈值下限（上下文窗口缺省时）——`max(8192, floor(W×0.008))`，
 * W 已知时由集成方按窗口计算后传入 {@link RuntimeContextProjectionOptions}。
 */
export const DEFAULT_DELTA_THRESHOLD = 8192

/**
 * L5 重置事件桥（本地接口）。依赖方向不便直接引用
 * `llm-pi-ai/cache-guardian` 的 `ResetLedger`，故在 agent-loop 侧定义最小
 * 契约；Phase 6 集成时把 `tailMerge` 映射为 cache-guardian 白名单的
 * `mergeRewrite`（合并重写），并把 `η×当前上下文` 的记账折入会话台账
 * （token-meter `foldResetWriteCost`）。`compaction` 保留给压缩子系统自有
 * 登记点，本投影不重复登记。
 */
export interface DeltaResetSink {
  /**
   * 登记一次 L5 白名单重置事件。
   * @param type - 事件类型（当前仅 `tailMerge` 由本投影发出）。
   * @param seq - 事件对应的会话日志 seq。
   * @param contextTokens - 重置时点的上下文 token 数（记账用，可选）。
   */
  registerResetEvent(type: 'tailMerge' | 'compaction', seq: number, contextTokens?: number): void
}

/** 一条待出站 delta 区间。 */
export interface DeltaRange {
  /** 产生该 delta 的 producer（system-prompt context 节名 / 内部 SOURCE）。 */
  readonly producer: string
  /** 增量文本。 */
  readonly text: string
  /** 登记时的 session seq（压缩边界回收与合并排序依据）。 */
  readonly seq: number
}

export interface RuntimeContextProjectionOptions {
  /** 尾部合并触发阈值（字符数）；缺省 {@link DEFAULT_DELTA_THRESHOLD}。 */
  deltaThreshold?: number
  /** L5 重置事件桥（Phase 6 对接 cache-guardian）。 */
  resetSink?: DeltaResetSink
  /**
   * 折叠延迟开关（M4′ 闭合 a）：为 true 时，若折叠目标的前驱是工具批末尾
   * toolResult，则推迟折叠（delta 保持 pending，不丢，等下一条真实 user 前有
   * assistant 中介，或由压缩边界回收）。集成方在「DeepSeek 系 openai-completions
   * 路由且 pi-ai 的 `requiresAssistantAfterToolResult` 垫片未启用」时置 true——
   * 避免 wire 上出现 `[toolResult, user(delta)]` 相邻对触发 provider 400/误读。
   * 缺省 false（垫片已启用、或非 openai-completions 路由时，工具批末尾
   * toolResult 前驱允许折叠，行为与本选项引入前一致）。
   *
   * 集成方设置（`agent.ts`）：本包不暴露 pi-ai 的 compat 垫片状态，判定归集成方——
   * 由 `agent.ts` 从 provider/路由解析出「openai-completions 且垫片关闭」后置入。
   * 无法可靠判定时保持缺省 false（不误伤非 DeepSeek 路由），垫片启用后由集成方
   * 撤销该标志恢复工具批末折叠。
   *
   * 该选项是**构造期初值**；provider 可在会话中途经 `agent/request` 瀑布流切换，
   * 故 `agent.ts` 的 `buildRequest` 会在每次解析出实际路由后经
   * {@link RuntimeContextProjection.setDeferFoldAfterToolResult} 重算更新，运行期
   * 切换不回溯束缚（见该 setter）。
   */
  deferFoldAfterToolResult?: boolean
}

/** 判断消息是否由运行时上下文 producer 拥有（plugin 源标记复用）。 */
function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

function textOf(message: Message): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

/** 工具结果消息（user 角色 + tool 源标记）。 */
function isToolResultMessage(message: Message): boolean {
  return message.role === 'user' && message.source.kind === 'tool'
}

/** 真实 user 消息（user 源标记——真实用户输入，区别于 plugin 注入与工具上下文）。 */
function isRealUserMessage(message: Message): boolean {
  return message.role === 'user' && message.source.kind === 'user'
}

/** 展平文本块（含嵌套 tool-result 内文本），用于工具覆盖检查。 */
function flattenBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? flattenBlocks(block.content) : '').join('')
}

/** assistant 消息是否携带与某 toolResult 匹配的 tool-call。 */
function hasMatchingToolCall(assistant: Message, result: Message): boolean {
  if (assistant.role !== 'assistant') return false
  const callId = result.source.kind === 'tool' ? result.source.callId : undefined
  if (callId === undefined) return false
  return assistant.content.some(block => block.type === 'tool-call' && block.id === callId)
}

/**
 * 把 delta 文本作为前缀折进真实 user 消息（保留原 source 与消息身份，
 * 不新增 custom 角色）。首块为文本时并入首块，否则前置一个文本块。
 */
function foldDeltaPrefix(message: UserMessage, delta: string): UserMessage {
  const content = [...message.content]
  const first = content[0]
  if (first?.type === 'text') {
    content[0] = { type: 'text', text: `${delta}${DELTA_SEPARATOR}${first.text}` }
  } else {
    content.unshift({ type: 'text', text: delta })
  }
  return freezeMessage({ ...message, content })
}

/** One uncommitted system-prompt surface operation for request admission or reconciliation. */
export interface SystemPromptCommit {
  /** Rendered prompt or empty content: an empty head records no prompt; empty tails are dormant. */
  message: SystemMessage
  /** `append` for a new system node, otherwise a replacement of one surviving system node. */
  intent: SurfaceIntent<'system/message'>
}

/** The request-series facts one prompt decision is made under. */
export interface SystemPromptDecisionInput {
  /** Whether the prepared route for this attempt reads a later `system` message as the effective prompt. */
  inHistory: boolean
  /**
   * Whether this step's request starts a new model-message series: a pre-step
   * listener declared one, the surface was replaced since the last request, or
   * the assembled tool schemas differ from the logged header.
   */
  startsSeries: boolean
}

/**
 * Decides how a rendered system prompt reaches the surface without owning the
 * commit. The first prompt, even empty, reserves surface node 0.
 * A capable continuing series appends changed nonempty text after the
 * cached history. An incapable route, broken series, or cleared prompt instead
 * normalizes the first system node and empties later active nodes. Dormant empty
 * tails do not supply effective text or require repeated replacements.
 */
export class SystemPromptProjection {
  constructor(private readonly session: Session) {}

  /** The surviving `system/message` nodes in surface order. */
  private systemNodes(): { seq: SessionSeq; text: string | undefined }[] {
    const nodes: { seq: SessionSeq; text: string | undefined }[] = []
    for (const seq of this.session.surface.nodes) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = this.session.eventAt(seq)
      if (event?.type !== 'system/message') continue
      const content = event.data.message.content
      const text = content.length === 0 ? '' : textOf(event.data.message)
      nodes.push({ seq, text })
    }
    return nodes
  }

  /**
   * Reconcile effective text and retained nodes with the prepared route and series.
   * @param rendered - the fully rendered system prompt; `''` when none is active.
   * @param input - the route capability and series facts for this step.
   * @returns ordered per-node updates; an empty list means no update is needed.
   */
  project(rendered: string, input: SystemPromptDecisionInput): SystemPromptCommit[] {
    const nodes = this.systemNodes()
    const head = nodes[0]
    if (head === undefined) {
      return [{ message: createSystemMessage(rendered, SOURCE), intent: { surfaceOp: 'append' } }]
    }
    const latest = nodes.findLast(node => node.text !== '') ?? head
    if (!input.inHistory || input.startsSeries || rendered.length === 0) {
      const updates = nodes.slice(1).filter(node => node.text !== '')
        .map(node => this.replace(node.seq, ''))
      if (head.text !== rendered) updates.push(this.replace(head.seq, rendered))
      return updates
    }
    if (latest.text === rendered) return []
    return [{ message: createSystemMessage(rendered, SOURCE), intent: { surfaceOp: 'append' } }]
  }

  private replace(seq: SessionSeq, text: string): SystemPromptCommit {
    return {
      message: createSystemMessage(text, SOURCE),
      intent: { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    }
  }
}

/**
 * 跟踪运行时上下文状态变化并登记 delta（L2 追加历史层）。
 *
 * 投影状态可重建（构造时从 session 事件回放基线：兼容旧格式快照日志，
 * 新格式从折叠进真实 user 消息的 delta 前缀提取）；
 * 后续事件流驱动 delta 的压缩边界回收。
 */
export class RuntimeContextProjection {
  /** 最近一次登记的完整上下文（diff 基线）；undefined = 尚未登记。 */
  private baseline: string | undefined
  /** 每节最近登记文本（delta 计算的节级基线）。 */
  private sectionBaseline = new Map<string, string>()
  /** 待出站 delta 区间（单一扁平数组，按 producer 聚合）。 */
  private deltas: DeltaRange[] = []
  /**
   * producer → deltas 下标列表（O(1) 聚合定位）。一个 producer 在压缩边界
   * 部分回收后可能持有多个区间，索引保留全部下标（追加总是作用到最后一个）。
   */
  private deltaIndex = new Map<string, number[]>()
  /** 上次 register 时的 session seq（工具结果覆盖检查窗口起点）。 */
  private lastRegisterSeq = 0
  /** 尾部合并次数（监测/测试）。 */
  private mergeCount = 0
  /** 被压缩边界回收、从未展示的 delta 字符数（L0 监测）。 */
  private reclaimedChars = 0
  /** 被压缩边界回收、从未展示的 delta 区间数（L0 监测）。 */
  private reclaimedRanges = 0
  /** 被工具结果覆盖判定抑制、未入 delta 的节数（L0 监测）。 */
  private coveredSuppressions = 0
  private readonly session: Session
  /** 尾部合并阈值（字符数）；构造时取选项/缺省，之后可被 {@link setDeltaThreshold} 更新。 */
  private deltaThreshold: number
  private readonly resetSink: DeltaResetSink | undefined
  /**
   * 折叠延迟开关（M4′ 闭合 a），语义见 {@link RuntimeContextProjectionOptions.deferFoldAfterToolResult}。
   * 构造期按初始路由定值，运行期由集成方（`agent.ts` 的 `buildRequest`）在每次
   * 请求路由解析后重算并 {@link setDeferFoldAfterToolResult} 更新——provider 可
   * 经 `agent/request` 瀑布流在会话中途切换（如降级到 openai-completions 系），
   * 固定初值会漏出 `[toolResult, user(delta)]` 相邻对触发 400。
   */
  private deferFoldAfterToolResult: boolean

  /**
   * 恢复投影状态并跟随权威 session 事件。
   * @param ctx - agent 作用域事件上下文。
   * @param session - 接收投影消息的会话。
   * @param options - delta 阈值与 L5 重置事件桥。
   */
  constructor(ctx: Context, session: Session, options: RuntimeContextProjectionOptions = {}) {
    this.session = session
    this.deltaThreshold = options.deltaThreshold ?? DEFAULT_DELTA_THRESHOLD
    this.resetSink = options.resetSink
    this.deferFoldAfterToolResult = options.deferFoldAfterToolResult ?? false

    // 会话恢复：从 session 事件回放重建基线（旧格式快照日志向后兼容；
    // 新格式从折叠进真实 user 消息的 delta 前缀提取，见 restoreBaseline）。
    const restored = this.restoreBaseline(session)
    this.baseline = restored?.text
    if (restored?.sections !== undefined) {
      for (const section of restored.sections) this.sectionBaseline.set(section.name, section.text)
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      // 压缩边界回收：替换事件（压缩）把边界前的 delta 并入摘要，
      // 随边界从发送视图消失——会话投影层保证压缩后 delta 区间被清空。
      if (isReplacementSurfaceEvent(event)) this.reclaimAtBoundary(event.surfaceOp.endSeq)
    })
  }

  /**
   * 从 surface 回放重建基线：
   * - 旧格式（Phase 4 前）：最后一条 owned `plugin/snapshot` 快照消息（文本 + 节表）。
   * - 新格式（Phase 4）：运行时上下文折叠进真实 user 消息的文本前缀
   *   （`<delta>\n\n<原文本>`），回放最后一条带 delta 前缀的真实 user 消息，按
   *   最后出现 {@link DELTA_SEPARATOR} 的位置切出前缀作为基线——即"最新折叠
   *   文本的提取"。首次折叠的前缀即完整上下文，恢复后上下文未变时不再重发
   *   （旧行为语义）；节级贡献无法从折叠文本恢复（节表为空），恢复后变化按节
   *   全量登记（保守，不丢信息）。最后折叠为 {@link CLEARED} 时模型被告知
   *   上下文已清空，基线未知 → 返回 undefined（首次登记整段上下文）。
   */
  private restoreBaseline(session: Session): {
    text: string | undefined
    sections: readonly ContextSnapshotSection[] | undefined
  } | undefined {
    const surface = new Set(session.surface.nodes)
    for (let index = session.seq - 1; index >= 0; index -= 1) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(SessionSeq(index))
      if (event?.type !== 'user/message' || !isOwned(event.data)) continue
      if (!surface.has(event.seq)) continue
      const sections = event.data.source.kind === 'plugin'
        && event.data.source.form === 'snapshot'
        ? event.data.source.sections
        : undefined
      return { text: textOf(event.data), sections }
    }
    for (let index = session.seq - 1; index >= 0; index -= 1) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(SessionSeq(index))
      if (event?.type !== 'user/message' || !isRealUserMessage(event.data)) continue
      if (!surface.has(event.seq)) continue
      const text = textOf(event.data)
      if (text === undefined) continue
      const separator = text.lastIndexOf(DELTA_SEPARATOR)
      // 前缀长度 = separator 位置；短于最小匹配长度不识别为折叠前缀
      //（可能是未折叠消息的自然分段），继续向前找。
      if (separator < MIN_MATCH_TEXT_LENGTH) continue
      // 已知保守行为：折叠文本形如 `<delta>\n\n<用户原文>`，此处按「最后一个
      // \n\n」切前缀。若用户原文本身含 \n\n，lastIndexOf 会落到原文内部分段，
      // 切出的 prefix 混入一段用户文本 → 基线被「撑大」。失败方向保守：撑大的
      // 基线不会等于真实上下文，恢复后首次 register 判定「有变化」→ 按节重新
      // 登记（多登记一次，绝不静默丢变更）。不做更精细的边界识别（会引入
      // delta/原文歧义解析风险），保守重发即安全。
      const prefix = text.slice(0, separator)
      if (prefix === CLEARED) return undefined
      return { text: prefix, sections: undefined }
    }
    return undefined
  }

  /**
   * 登记运行时上下文状态变化（内部登记）：只登记增量文本（delta），
   * 不产生完整快照 user 消息；工具结果已体现的变更不入 delta（去重规则）。
   * 首次登记（无基线）把整段当前上下文作为首条 delta——等价旧行为的
   * 首个完整快照；从新格式折叠文本恢复的会话在上下文未变时不重发
   * （基线 = 最新折叠前缀），上下文变化时按节全量登记（节表不可恢复）。
   * @param current - 当前完整渲染上下文（`joinContextSections` 结果）。
   * @param sections - 形成该快照的命名贡献（节），按渲染顺序。
   */
  register(current: string, sections: readonly ContextSnapshotSection[]): void {
    if (this.baseline === undefined) {
      this.lastRegisterSeq = this.sessionSeq()
      if (current.length === 0) {
        this.baseline = ''
        return
      }
      this.registerDelta(SOURCE, current)
      this.baseline = current
      this.sectionBaseline = new Map(sections.map(section => [section.name, section.text]))
      this.maybeTailMerge()
      return
    }
    if (this.baseline === current) {
      this.lastRegisterSeq = this.sessionSeq()
      return
    }
    if (current.length === 0) {
      // 全部清空：登记 CLEARED delta（旧行为 CLEARED 消息的 delta 形态），
      // 并重置节级基线，使后续重建的上下文作为新节重新登记。
      this.registerDelta(SOURCE, CLEARED)
      this.sectionBaseline.clear()
    } else {
      for (const section of sections) {
        if (this.sectionBaseline.get(section.name) === section.text) continue
        if (this.coveredByToolResults(section.text)) {
          this.coveredSuppressions += 1
        } else {
          this.registerDelta(section.name, section.text)
        }
        this.sectionBaseline.set(section.name, section.text)
      }
      // 被移除的节不做 delta 表达（全局清空走 CLEARED）；仅从节级基线移除，
      // 使后续恢复该节时作为新节登记。
      for (const name of [...this.sectionBaseline.keys()]) {
        if (!sections.some(section => section.name === name)) this.sectionBaseline.delete(name)
      }
    }
    this.baseline = current
    this.lastRegisterSeq = this.sessionSeq()
    this.maybeTailMerge()
  }

  /**
   * 出站折叠：把待出站 delta 折进下一条真实 user 消息的文本前缀。
   *
   * preflight 不通过（序列违反协议交替强约束、或目标前最后一条消息不是
   * assistant / 工具批末尾 toolResult）或无真实 user 消息时推迟到下次；
   * 长工具循环中 delta 缓存不进视图（保持 pending），等压缩边界回收。
   *
   * DeepSeek 系 provider 风险（M4′ 闭合 a）：折叠后的 user 消息可能紧跟
   * 一条 toolResult 出现在 wire 上（`canFoldAfter` 默认允许工具批末尾
   * toolResult 作为前驱）。pi-ai 的 `openai-completions` 垫片
   * `requiresAssistantAfterToolResult`（在 toolResult 与后续 user 之间注入
   * 占位 assistant 消息）默认关闭——`detectCompat` 对所有 provider 返回
   * `false`，DSH 的 `llm-pi-ai` 也仅在 profile compat 中把它列为可配置项
   * （`catalog.ts` `'offer'`），未对 DeepSeek 系路由默认启用。这类 provider
   * 对 `[toolResult, user]` 序列可能报错或误读。
   *
   * 缓解（本投影侧）：集成方在「openai-completions 路由且该垫片未启用」时，
   * 通过构造选项 {@link RuntimeContextProjectionOptions.deferFoldAfterToolResult}
   * =true 让 `canFoldAfter` 对工具批末尾 toolResult 前驱推迟折叠（delta 保持
   * pending，不丢，等 assistant 中介或压缩边界回收）。垫片启用后集成方撤销该
   * 标志（=false）即恢复工具批末折叠。判定所需 provider/compat 状态不在本包
   * 暴露，由 `agent.ts` 从路由解析后传入。
   *
   * @param messages - 本轮将进入会话的真实 user 消息（pre-step 决策结果）。
   * @returns 折叠后的新消息数组；未折叠时返回原消息（浅拷贝）。
   */
  foldInto(messages: readonly UserMessage[]): UserMessage[] {
    if (this.deltas.length === 0 || messages.length === 0) return [...messages]
    const derived = this.session.deriveMessages()
    const targetIndex = messages.findIndex(isRealUserMessage)
    if (targetIndex < 0) return [...messages]
    const prospective = [...derived, ...messages]
    if (!this.validateSequence(prospective)) return [...messages]
    if (!this.canFoldAfter(prospective, derived.length + targetIndex)) return [...messages]
    const delta = this.takeDeltas()
    const result = [...messages]
    // oxlint-disable-next-line typescript/no-non-null-assertion -- targetIndex comes from canFoldAfter's validated sequence
    result[targetIndex] = foldDeltaPrefix(messages[targetIndex]!, delta)
    return result
  }

  /**
   * preflight（协议交替强约束）：出站序列中不存在
   * [toolResult 不紧跟其 assistant(tool_use)]，也不存在
   * [user 紧邻 toolResult 之后还有 toolResult] 的相邻对。
   */
  private validateSequence(messages: readonly Message[]): boolean {
    for (let index = 0; index < messages.length; index += 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by messages.length
      const message = messages[index]!
      if (isToolResultMessage(message)) {
        // 工具批内结果跟随其批首；批首必须紧跟携带匹配 tool-call 的 assistant。
        let anchor = index - 1
        // oxlint-disable-next-line typescript/no-non-null-assertion -- anchor < index, bounded by the loop condition
        while (anchor >= 0 && isToolResultMessage(messages[anchor]!)) anchor -= 1
        const assistant = messages[anchor]
        if (assistant === undefined || !hasMatchingToolCall(assistant, message)) return false
        continue
      }
      if (message.role !== 'user') continue
      // user 消息不得夹在 [toolResult, user, toolResult] 之间。
      const prev = messages[index - 1]
      const next = messages[index + 1]
      if (prev !== undefined && isToolResultMessage(prev) && next !== undefined && isToolResultMessage(next)) return false
    }
    return true
  }

  /**
   * 折叠时机约束（M4′ 闭合 c）：折叠目标（下一条真实 user 消息）之前最后一条
   * **非 user 消息**为 assistant 或工具批末尾 toolResult 时方可折叠；plugin 源
   * user 消息（工具上下文等注入消息）夹在中间时向前跳过，不阻断折叠。目标位于
   * 序列开头（无前驱）时允许折叠。preflight（{@link validateSequence}）已保证
   * 序列中不存在孤立 toolResult 与 [toolResult, user, toolResult] 相邻对，因此
   * 向前落到的 toolResult 必为该工具批的批末。
   *
   * M4′ 闭合 a（DeepSeek 系折叠延迟）：当 {@link deferFoldAfterToolResult} 为
   * true（集成方判定 openai-completions 路由且 `requiresAssistantAfterToolResult`
   * 垫片未启用）时，前驱为工具批末尾 toolResult 也推迟折叠——避免 wire 上出现
   * `[toolResult, user(delta)]` 相邻对。delta 不丢：保持 pending，等下一条真实
   * user 前有 assistant 中介（前驱变为 assistant 即放行），或由压缩边界回收。
   */
  private canFoldAfter(prospective: readonly Message[], targetIndex: number): boolean {
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index < targetIndex <= prospective.length
      const message = prospective[index]!
      if (message.role === 'user' && message.source.kind === 'plugin') {
        // 前驱是运行时上下文 producer 的格式异常消息（多块/非文本快照 =
        // 上一次上下文交付失败）时推迟折叠：等下一轮折叠时机（前驱变为
        // assistant 或工具批末尾 toolResult）再展示积压的 delta。
        if (isOwned(message as UserMessage) && textOf(message) === undefined) return false
        continue
      }
      if (message.role === 'assistant') return true
      // 前驱是工具批末尾 toolResult：默认放行折叠；集成方声明延迟
      // （deferFoldAfterToolResult，openai-completions 且垫片未启用）时推迟。
      if (isToolResultMessage(message)) return !this.deferFoldAfterToolResult
      // 前驱是真实 user 消息（非 plugin、非 toolResult）→ 保守推迟：实现只跳过
      // plugin 注入消息，遇到真实 user 即停，不越过它去够更早的 assistant/toolResult。
      return false
    }
    return true
  }

  /** 取出全部 pending delta 文本并清空（折叠即消费；会话日志保留折叠后的真实 user 消息）。 */
  private takeDeltas(): string {
    const text = this.deltas.map(range => range.text).join(DELTA_SEPARATOR)
    this.deltas = []
    this.deltaIndex.clear()
    return text
  }

  /** 按 producer 聚合登记：同一 producer 的尾部区间继续累积；重复文本去重。 */
  private registerDelta(producer: string, text: string): void {
    if (text.length === 0) return
    const seq = this.sessionSeq()
    const indexes = this.deltaIndex.get(producer)
    if (indexes === undefined || indexes.length === 0) {
      this.deltaIndex.set(producer, [this.deltas.length])
      this.deltas.push({ producer, text, seq })
      return
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- indexes is non-empty (checked above)
    const index = indexes[indexes.length - 1]!
    // oxlint-disable-next-line typescript/no-non-null-assertion -- deltaIndex entries always pair with a pushed delta
    const range = this.deltas[index]!
    if (range.text.endsWith(text)) return // 聚合去重：已累积的重复文本
    this.deltas[index] = { producer, text: `${range.text}${DELTA_SEPARATOR}${text}`, seq }
  }

  /**
   * 尾部合并：delta 积压超阈值时压缩尾部连续区间为单区间，登记重置事件
   * （Phase 6 映射为 cache-guardian `mergeRewrite`）并记账 `η×当前上下文`
   * （由集成方在 sink 完成）。K = ceil(delta阈值/每轮期望delta) 的轮数
   * 预估由 L0 监测侧按 `pendingDeltaText()` 观测。
   */
  private maybeTailMerge(): void {
    if (this.deltas.length < 2) return
    let total = 0
    for (const range of this.deltas) total += range.text.length
    if (total <= this.deltaThreshold) return
    const seq = this.sessionSeq()
    const text = this.deltas.map(range => range.text).join(DELTA_SEPARATOR)
    this.deltas = [{ producer: SOURCE, text, seq }]
    this.deltaIndex = new Map([[SOURCE, [0]]])
    this.mergeCount += 1
    // contextTokens = 重置时点的上下文 token 数估计：以当前完整渲染上下文
    // 文本长度的 1/3 作为 token 近似（设计 L0：ASCII 密集按 chars/3 保守估算，
    // 避免 η×上下文 记账系统性低估）。
    this.resetSink?.registerResetEvent('tailMerge', seq, this.estimatedContextTokens())
  }

  /** 重置时点的上下文 token 数估计（chars/3 保守启发式，设计 L0；无基线时为 0）。 */
  private estimatedContextTokens(): number {
    const baseline = this.baseline ?? ''
    return Math.ceil(baseline.length / 3)
  }

  /**
   * 更新尾部合并阈值（字符数）。上下文窗口在请求解析后才知道
   * （`agent.ts` 的 `buildRequest`），窗口缩放公式
   * `max(8192, floor(W×0.008))` 由集成方计算后传入。
   * @param threshold - 新的 delta 阈值。
   */
  setDeltaThreshold(threshold: number): void {
    this.deltaThreshold = Math.max(0, Math.floor(threshold))
  }

  /**
   * 更新折叠延迟开关（M4′ 闭合 a）。集成方在每次请求解析出实际 provider 路由后
   * 重算并传入（`agent.ts` 的 `buildRequest`），使运行期 provider 切换（含降级到
   * openai-completions 系）即时反映到后续折叠决策，而不受构造期初值束缚。
   * @param value - true 表示对工具批末尾 toolResult 前驱推迟折叠。
   */
  setDeferFoldAfterToolResult(value: boolean): void {
    this.deferFoldAfterToolResult = value
  }

  /**
   * 压缩边界回收：替换事件（压缩）覆盖到的 delta 区间已并入摘要、随边界
   * 从发送视图消失；边界之后的 delta 保留（等待后续折叠）。
   */
  private reclaimAtBoundary(end: number): void {
    if (this.deltas.length === 0) return
    const kept: DeltaRange[] = []
    for (const range of this.deltas) {
      if (range.seq <= end) {
        this.reclaimedChars += range.text.length
        this.reclaimedRanges += 1
      } else {
        kept.push(range)
      }
    }
    if (kept.length !== this.deltas.length) {
      this.deltas = kept
      // 按 range 顺序重建索引：同一 producer 可能保留多个区间（边界部分回收），
      // 必须保留全部下标，避免后续 registerDelta 聚合到错误的尾部区间。
      const index = new Map<string, number[]>()
      kept.forEach((range, rangeIndex) => {
        const indexes = index.get(range.producer)
        if (indexes !== undefined) indexes.push(rangeIndex)
        else index.set(range.producer, [rangeIndex])
      })
      this.deltaIndex = index
    }
  }

  /**
   * 去重规则：工具结果已体现的状态变更不入 delta。启发式——变更文本
   * （节文本）作为子串出现在上次登记以来的工具结果中即视为已覆盖（长工具
   * 循环中状态可感知性由工具结果承担，delta 延迟展示不构成功能退化）。
   * 短文本（< {@link MIN_MATCH_TEXT_LENGTH} 字符）不做子串判定，避免
   * 无关联工具输出恰好包含短节文本造成误报（合法变更被静默跳过）。
   */
  private coveredByToolResults(text: string): boolean {
    if (text.length < MIN_MATCH_TEXT_LENGTH) return false
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = this.session.snapshotEvents()
    for (let index = this.lastRegisterSeq; index < events.length; index += 1) {
      const event = events[index]
      if (event?.type !== 'tool/result') continue
      const flat = flattenBlocks(event.data.message.content)
      if (flat.length > 0 && flat.includes(text)) return true
    }
    return false
  }

  /** 当前待出站 delta 总字符数。 */
  pendingChars(): number {
    let total = 0
    for (const range of this.deltas) total += range.text.length
    return total
  }

  /** 当前待出站 delta 文本（折叠顺序，L0 监测/测试）。 */
  pendingDeltaText(): string {
    return this.deltas.map(range => range.text).join(DELTA_SEPARATOR)
  }

  /** 当前待出站 delta 区间数。 */
  pendingRangeCount(): number {
    return this.deltas.length
  }

  /** 被压缩边界回收、从未展示的 delta 字符数（L0 监测：未展示 delta 计数）。 */
  reclaimedUnfoldedChars(): number {
    return this.reclaimedChars
  }

  /** 被压缩边界回收、从未展示的 delta 区间数（L0 监测）。 */
  reclaimedUnfoldedRanges(): number {
    return this.reclaimedRanges
  }

  /** 被工具结果覆盖判定抑制、未入 delta 的节数（L0 监测：去重命中计数）。 */
  coveredSuppressionCount(): number {
    return this.coveredSuppressions
  }

  /** 尾部合并次数（监测/测试）。 */
  tailMergeCount(): number {
    return this.mergeCount
  }

  private sessionSeq(): number {
    return this.session.seq
  }
}
