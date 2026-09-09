/**
 * L5 缓存保障层：三段规范化哈希（pi convertMessages 规范化镜像）、轮间单调
 * 延伸检查、重置事件白名单台账、per-provider κ/η 参数、重置事件记账。
 *
 * @module dsh-llm-pi-ai/cache-guardian
 *
 * @see CONTEXT-CACHE-MANAGEMENT.md §2 L5 — 前缀不变量守护规格
 *
 * ## pi 保真口径（交付口径，V2 返工固化）
 * 本文件的规范化是 pi-ai 0.82.1 `packages/ai/src/api/anthropic-messages.ts`
 * 转换链（convertMessages / convertContentBlocks / convertTools /
 * convertToolResult）的**规范化镜像**：guard 哈希变化 ⇔ pi 请求体字节变化，
 * 声明的等价类与未建模项除外。下列行号均指该文件。已镜像行为：
 * - tools **保序**（:1336 `tools.map`；Anthropic 缓存对 tools 顺序敏感）、
 *   name OAuth CC 大小写映射（:1354 等价类）、description 原样透传（:1355）、
 *   parameters 只留 {properties,required}（:1339-1351 legacyInputSchema）；
 * - systemPrompt 仅 surrogate 清理、**不 trim**（:1021/:1030）；
 * - user 字符串内容：raw trim 为空整条丢弃（:1171），否则清理后进哈希；
 *   统一规范成单文本块形式（cache_control 注入等价类，:1307-1315）；
 * - user 块数组：text 先清理再按清理值剔空（:1178-1201），image 只留类型标记；
 * - assistant text 空块剔除（:1212）；thinking `redacted` →
 *   redacted_thinking{data}（:1219-1225）；thinking 空文本且无签名剔除
 *   （:1228，raw 判断）；无签名 → allowEmptySignature=true 保留
 *   thinking{signature:''}、否则降级文本（:1232-1244，默认 false，见
 *   {@link NormalizeOptions}）；有签名 → thinking{signature}（:1246-1250）；
 *   toolCall 含 id、name、`arguments ?? {}`（:1252-1258）；
 *   **stopReason 不进哈希**（pi 请求体不含 stop_reason，:1262-1265）；
 * - toolResult 内容镜像 convertContentBlocks（:118-165）：纯文本 →
 *   `join('\n')` 成字符串、**不剔空块**（:131-135）；含 image → 块数组、
 *   空 text 块保留、无 text 时补 `(see attached image)` 占位块（:137-163）；
 *   tool_result 整条永不丢弃（:1137-1145）。
 *
 * ## 已知未建模清单（显式声明的偏差，不算镜像缺口）
 * 1. **transformMessages 上游改写**（pi `api/transform-messages.ts`，在
 *    convertMessages 之前执行）：stopReason error/aborted 的 assistant 消息
 *    被整条剔除、孤儿 toolCall 合成 "No result provided" 结果、非 vision
 *    模型图片降级占位、跨模型 thinking/toolCallId 规范化。这些是
 *    「历史 + 模型」的确定函数，模型变化已由 modelChange 重置事件覆盖。
 * 2. **deferred tools / tool_reference / siblingContent**（pi :983-994、
 *    :1120-1152）：依赖 model.compat.supportsToolReferences 与
 *    splitDeferredTools 的整块重排逻辑，guard 不建模；工具集变化由
 *    toolsetChange 重置事件覆盖。
 * 3. image 的 data/mimeType 不进哈希（性能取舍；append-only 历史中
 *    图片内容不原地变化，原地改写属重置事件域）。
 * 4. toolName 进 toolResult 哈希（pi wire 不含；保留为原地改写纵深检测，
 *    误报方向，已声明）。
 * 5. stableStringify 稳定键序为等价类声明：JSON 键插入顺序变化不算断裂。
 * 6. strict 工具 schema 的顶层附加键与 strict 标记被 {properties,required}
 *    过滤剔除（仅 compat.supportsStrictTools 生效时出现，模型变化由
 *    modelChange 事件覆盖）。
 */

import { createHash } from 'node:crypto'
import type {
  Context as PiContext,
  ImageContent,
  Message as PiMessage,
  TextContent,
  ThinkingContent,
  Tool as PiTool,
  ToolResultMessage,
} from '@earendil-works/pi-ai'

// ---------------------------------------------------------------------------
// 1. 三段规范化哈希
// ---------------------------------------------------------------------------

/**
 * 规范化选项。镜像 pi convertMessages 中依赖 model.compat 的分支：
 * guard 拿不到 model，默认取 pi 的默认值（allowEmptySignature=false，
 * 见 anthropic-messages.ts:192 `model.compat?.allowEmptySignature ?? false`）。
 * 调用方若已知目标模型 compat，可显式传入以对齐该模型的 wire 行为。
 */
export interface NormalizeOptions {
  /**
   * 对应 pi `compat.allowEmptySignature`。true 时无签名 thinking 保留为
   * `thinking{signature:''}`（pi :1234-1239）；false（默认）降级为纯文本
   * （pi :1240-1243）。
   */
  readonly allowEmptySignature?: boolean
}

/**
 * 一段 GuardState：system/tools 段是整段哈希，messages 段携带
 * 逐条消息的哈希链头，用于轮间前缀检查。
 */
export interface GuardState {
  /** SHA-256 hex of the normalized system segment. */
  readonly systemHash: string
  /** SHA-256 hex of the normalized tools segment. */
  readonly toolsHash: string
  /** SHA-256 hex of the normalized whole messages segment. */
  readonly messagesHash: string
  /** 逐条规范化消息的哈希链头；轮间单调检查以它为前缀依据。 */
  readonly messageHashes: readonly string[]
  /**
   * 本 GuardState 对应的会话日志 seq（取状态时的 session seq）。
   * 供 {@link verifyMonotonicWithReset} 的豁免窗口判断：仅当最近重置事件
   * 发生在上一状态之后（本轮是重置后第一个请求）才豁免。缺省（旧调用方
   * 未携带）时该函数退回旧行为（非空白名单台账即豁免）。
   */
  readonly seq?: number
}

/**
 * Claude Code 工具名（规范大写）—— 用于 OAuth 工具名映射。
 * 来源：https://cchistory.mariozechner.at/data/prompts-2.1.11.md
 */
const CLAUDE_CODE_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'KillShell', 'NotebookEdit', 'Skill', 'Task', 'TaskOutput',
  'TodoWrite', 'WebFetch', 'WebSearch',
] as const

const ccToolLookup = new Map<string, string>(
  CLAUDE_CODE_TOOLS.map(t => [t.toLowerCase(), t]),
)

/**
 * 规范化工具名：若匹配 Claude Code 工具（大小写不敏感），
 * 返回规范大写形式；否则原样返回。哈希前必须应用此映射，
 * 使 OAuth 与非 OAuth 路径的哈希一致。
 */
function normalizeToolName(name: string): string {
  return ccToolLookup.get(name.toLowerCase()) ?? name
}

/** 清理未配对 Unicode surrogate（与 pi-ai sanitizeSurrogates 同规则）。 */
function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

/** 判断字符串是否为空或仅含空白。 */
function isBlank(text: string): boolean {
  return text.trim().length === 0
}

/**
 * thinking 块是否带有效签名。镜像 pi-ai convertMessages 的
 * `hasThinkingSignature`（`anthropic-messages.ts` 1227：
 * `!!signature && signature.trim().length > 0`）。
 */
function hasThinkingSignature(block: ThinkingContent): boolean {
  const signature = block.thinkingSignature
  return !!signature && signature.trim().length > 0
}

/** 稳定键序的 JSON 序列化：保证同构对象产出同一字符串。 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const pairs = keys.map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
  return `{${pairs.join(',')}}`
}

// ---- segment normalization -------------------------------------------------

/**
 * 规范化 system 段：仅 surrogate 清理，**不 trim**（镜像 pi：
 * `sanitizeSurrogates(context.systemPrompt)` 原样入 body，
 * `anthropic-messages.ts` 1021/1030）。
 * 段内不含 cache_control（那是 adapter 注入的），无块结构可剔除。
 */
export function normalizeSystem(system: string | undefined): string {
  if (system === undefined || system.length === 0) return ''
  return sanitizeSurrogates(system)
}

/**
 * 镜像 pi 非 strict 路径的 input_schema 过滤（convertTools :1339-1351：
 * `legacyInputSchema = {type:'object', properties: ?? {}, required: ?? []}`）：
 * 只保留 {properties, required}，顶层附加键（$schema/additionalProperties 等）
 * 不进 wire 也不进哈希。strict 分支的偏差见文件头未建模清单第 6 条。
 */
function filterToolParameters(parameters: unknown): { properties: unknown; required: unknown } {
  const schema = (parameters ?? {}) as { properties?: unknown; required?: unknown }
  return { properties: schema.properties ?? {}, required: schema.required ?? [] }
}

/**
 * 规范化 tools 段：**保序**（镜像 pi `convertTools` 的 `tools.map` :1336 ——
 * Anthropic 缓存对 tools 顺序敏感，重排即断裂，不做排序归一）、
 * OAuth 工具名映射（等价类）、description 原样透传（pi :1355 不清理）、
 * parameters 只留 {properties,required}；序列化天然剔除
 * cache_control/ttl/eager_input_streaming 及任何 adapter 附加字段。
 */
export function normalizeTools(tools: readonly PiTool[] | undefined): string {
  if (tools === undefined || tools.length === 0) return '[]'
  const normalized = tools.map(tool => ({
    name: normalizeToolName(tool.name),
    description: tool.description,
    parameters: filterToolParameters(tool.parameters),
  }))
  return stableStringify(normalized)
}

/** 规范化一个文本块（surrogate 清理）；剔除 cache_control/ttl 等附加字段。 */
function normalizeTextBlock(text: string): TextContent {
  return { type: 'text', text: sanitizeSurrogates(text) }
}

/** 规范化一个 image 块：只保留类型标记（data/mimeType 不进哈希）。 */
function normalizeImageBlock(): ImageContent {
  return { type: 'image', data: '', mimeType: 'image/png' }
}

/**
 * 镜像 pi `convertContentBlocks`（`anthropic-messages.ts` 118-165），用于
 * toolResult 内容：纯文本块 → `join('\n')` 成字符串、**不剔空块**（:131-135，
 * 空块参与拼接，`['a','']` 与 `['a']` 的 wire 不同）；含 image → 块数组，
 * 空 text 块同样保留（map 无过滤），无 text 块时补 `(see attached image)`
 * 占位（:155-162）。image 只留类型标记（data/mimeType 不进哈希，见文件头
 * 未建模清单第 3 条）。
 */
function normalizeToolResultContent(
  content: readonly (TextContent | ImageContent)[],
): string | unknown[] {
  const hasImages = content.some(block => block.type === 'image')
  if (!hasImages) {
    return sanitizeSurrogates(content.map(block => (block as TextContent).text).join('\n'))
  }
  const blocks: unknown[] = content.map(block => block.type === 'text'
    ? normalizeTextBlock(block.text)
    : normalizeImageBlock())
  if (!blocks.some(block => (block as { type: string }).type === 'text')) {
    blocks.unshift({ type: 'text', text: '(see attached image)' })
  }
  return blocks
}

/**
 * 规范化单条 pi-ai 消息（convertMessages 镜像，含 NormalizeOptions 分支）。
 * 规则见文件头「pi 保真口径」。返回 null 表示 pi 会把整条消息从请求体中
 * 剔除（user 空内容 / user 块全空 / assistant 块全空）；toolResult 在 pi
 * 中永不剔除，故不返回 null。
 */
export function normalizeMessage(message: PiMessage, options?: NormalizeOptions): unknown {
  const allowEmptySignature = options?.allowEmptySignature ?? false
  if (message.role === 'user') {
    const userMessage = message
    if (typeof userMessage.content === 'string') {
      // pi :1171 用 raw（清理前）trim 判空；仅含未配对 surrogate 的字符串
      // 清理后为空串仍会进 wire，故此处不提前剔除。
      if (userMessage.content.trim().length === 0) return null
      // pi-ai convertMessages 对末条用户消息注入 cache_control 时，会把
      // 字符串内容改写为单文本块数组（`anthropic-messages.ts` 1308-1315）；
      // 为保持注入前后哈希不变，字符串形式统一规范化成单文本块数组。
      return { role: 'user', content: [normalizeTextBlock(sanitizeSurrogates(userMessage.content))] }
    }
    // pi :1195-1200：text 块先清理、再按清理后的值 trim 判空剔除。
    const blocks = userMessage.content
      .map(block => block.type === 'text'
        ? (isBlank(sanitizeSurrogates(block.text)) ? null : normalizeTextBlock(block.text))
        : normalizeImageBlock())
      .filter((block): block is TextContent | ImageContent => block !== null)
    if (blocks.length === 0) return null
    return { role: 'user', content: blocks }
  }

  if (message.role === 'assistant') {
    const assistant = message
    const blocks: unknown[] = []
    for (const block of assistant.content) {
      if (block.type === 'text') {
        if (!isBlank(block.text)) blocks.push(normalizeTextBlock(block.text))
        continue
      }
      if (block.type === 'thinking') {
        // Redacted thinking：pi 把不透明载荷以 redacted_thinking{data} 发回
        // （:1219-1225，载荷存于 thinkingSignature）。pi 写 `thinkingSignature!`
        // 是非空断言（纯编译期，运行时不改值）：签名缺失时 data 原样为
        // undefined，经 JSON 序列化会丢弃该键。此处镜像其运行时语义——直接
        // 透传 block.thinkingSignature，**不加 `?? ''` 兜底**，使「redacted 但
        // 签名缺失」病态输入下 undefined 与 '' 产生不同哈希（stableStringify
        // 把 undefined 渲染为 null、'' 渲染为 ""），与 pi wire 的可区分性一致。
        // 旧 `?? ''` 会把 undefined 与 '' 折叠为同一哈希，是相对 pi 的漏检
        // 偏差（wire 变了而 guard 哈希不变），已对齐 pi（非未建模偏差）。
        if (block.redacted) {
          blocks.push({ type: 'redactedThinking', data: block.thinkingSignature })
          continue
        }
        const signed = hasThinkingSignature(block)
        // pi :1228：空 thinking 文本（raw 判断）且无签名 → 剔除。
        if (block.thinking.trim().length === 0 && !signed) continue
        const cleaned = sanitizeSurrogates(block.thinking)
        if (!signed) {
          // pi :1232-1244：无签名 → allowEmptySignature 模型保留
          // thinking{signature:''}，否则确定性降级为文本。
          blocks.push(allowEmptySignature
            ? { type: 'thinking', thinking: cleaned, signature: '' }
            : normalizeTextBlock(cleaned))
        } else {
          blocks.push({ type: 'thinking', thinking: cleaned, signature: block.thinkingSignature })
        }
        continue
      }
      // toolCall：pi 发送 tool_use{id,name,input}（:1252-1258）。
      // id 进 wire 必须进哈希；arguments 缺省时 pi 发 {}（:1257）。
      const toolCall = block
      blocks.push({
        type: 'toolCall',
        id: toolCall.id,
        name: normalizeToolName(toolCall.name),
        // pi folds missing arguments to {} on the wire (:1257), but locally
        // built ToolCall objects can still carry undefined; the spec pins
        // missing ≡ {} hashing, so the type-level "unnecessary" fold is
        // load-bearing at runtime.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime invariant: missing arguments hash like {}.
        arguments: toolCall.arguments ?? {},
      })
    }
    if (blocks.length === 0) return null
    // stopReason 不进哈希：pi 请求体不含 stop_reason（:1262-1265）。
    return { role: 'assistant', content: blocks }
  }

  // toolResult → tool_result 块（convertToolResult :1120-1153）：整条永不
  // 剔除；toolName 不在 wire 上，保留为原地改写纵深检测（未建模清单第 4 条）。
  const result = message as ToolResultMessage
  return {
    role: 'toolResult',
    toolCallId: result.toolCallId,
    toolName: normalizeToolName(result.toolName),
    content: normalizeToolResultContent(result.content),
    isError: result.isError,
  }
}

/**
 * 规范化 messages 段：逐条规范化、剔除 pi 会整条丢弃的空消息，返回稳定序列化串。
 */
export function normalizeMessages(messages: readonly PiMessage[], options?: NormalizeOptions): string {
  if (messages.length === 0) return '[]'
  const normalized = messages
    .map(message => normalizeMessage(message, options))
    .filter((message): message is NonNullable<typeof message> => message !== null)
  return stableStringify(normalized)
}

/** SHA-256 hex digest。 */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * 对 pi-ai Context 的三个段分别计算规范化哈希。
 * messages 段额外产出逐条消息哈希链头，供单调延伸检查使用。
 * @param context - 待计算的 pi-ai Context。
 * @param seq - 可选：状态对应的会话日志 seq（豁免窗口判断用）。
 * @param options - 可选：镜像 pi compat 分支的规范化选项（如 allowEmptySignature）。
 */
export function computeGuardState(
  context: PiContext,
  seq?: number,
  options?: NormalizeOptions,
): GuardState {
  const systemStr = normalizeSystem(context.systemPrompt)
  const toolsStr = normalizeTools(context.tools)
  const messages = context.messages
    .map(message => normalizeMessage(message, options))
    .filter((message): message is NonNullable<typeof message> => message !== null)
  return {
    systemHash: sha256(systemStr),
    toolsHash: sha256(toolsStr),
    messagesHash: sha256(stableStringify(messages)),
    messageHashes: messages.map(message => sha256(stableStringify(message))),
    ...seq === undefined ? {} : { seq },
  }
}

/**
 * 针对单个段计算规范化哈希。
 * @param segment - 段类型：system（string）、tools（Tool[]）、messages（Message[]）
 * @param content - 对应段的 pi-ai 内容
 * @param options - 可选：messages 段的 compat 分支选项
 * @returns 规范化后的 SHA-256 hex
 */
export function hashSegment(
  segment: 'system' | 'tools' | 'messages',
  content: unknown,
  options?: NormalizeOptions,
): string {
  switch (segment) {
    case 'system':
      return sha256(normalizeSystem(content as string | undefined))
    case 'tools':
      return sha256(normalizeTools(content as readonly PiTool[] | undefined))
    case 'messages':
      return sha256(normalizeMessages(content as readonly PiMessage[], options))
  }
}

// ---------------------------------------------------------------------------
// 2. 轮次间单调延伸检查
// ---------------------------------------------------------------------------

/** 单调检查结果。 */
export interface MonotonicResult {
  /** 是否通过检查。 */
  readonly ok: boolean
  /** 不通过时的原因描述。 */
  readonly reason?: string
}

/**
 * 验证上一轮 -> 本轮的三段哈希链是否单调延伸。
 *
 * - system/tools 段：上一轮哈希必须与本轮逐字节相等（冻结段）。
 * - messages 段：上一轮的逐条消息哈希链头必须是本轮链头的前缀
 *   （前缀逐条相等 + 本轮尾部新增），即只允许尾部追加。
 *
 * @param prev - 上一轮（应更短/更早）的 GuardState。
 * @param next - 本轮（应更长/更晚）的 GuardState。
 * @returns 检查结果。
 */
export function verifyMonotonic(prev: GuardState, next: GuardState): MonotonicResult {
  if (prev.systemHash !== next.systemHash) {
    return { ok: false, reason: 'system segment changed; system is frozen (reset event required)' }
  }
  if (prev.toolsHash !== next.toolsHash) {
    return { ok: false, reason: 'tools segment changed; tools are frozen (reset event required)' }
  }
  if (next.messageHashes.length < prev.messageHashes.length) {
    return {
      ok: false,
      reason: `messages segment shrank from ${prev.messageHashes.length} to ${next.messageHashes.length} (not monotonic)`,
    }
  }
  for (let i = 0; i < prev.messageHashes.length; i++) {
    if (prev.messageHashes[i] !== next.messageHashes[i]) {
      return {
        ok: false,
        reason: `message at index ${i} was rewritten in place (not monotonic; reset event required)`,
      }
    }
  }
  return { ok: true }
}

/**
 * 带重置台账的单调检查：纯单调检查不通过时，若台账中登记过
 * 白名单内的重置事件，则视为豁免（重置事件后的首个请求即 warm-up 轮，
 * 命中率计域外，前缀不变量不适用 —— L0 豁免域 (b)）。
 *
 * 豁免窗口：仅在台账中最大 seq 的重置事件发生在上一 GuardState 之后
 * （即本轮是该重置后第一个请求）时豁免；注册顺序与 seq 乱序不影响判断。
 * 若 `prev.seq` 缺省（旧调用方未携带），退回旧行为：非空白名单台账即豁免。
 *
 * @param prev - 上一轮 GuardState。
 * @param next - 本轮 GuardState。
 * @param ledger - 重置事件台账。
 * @returns 通过（含豁免）返回 ok，否则返回失败原因。
 */
export function verifyMonotonicWithReset(
  prev: GuardState,
  next: GuardState,
  ledger: ResetLedger,
): MonotonicResult {
  const result = verifyMonotonic(prev, next)
  if (result.ok) return result
  if (ledger.events.length === 0) return result
  if (!ledger.events.every(entry => isAllowedReset(entry.type))) return result
  // 缺省 prev.seq：退回旧行为（全豁免）。
  if (prev.seq === undefined) return { ok: true }
  // 取台账中的**最大 seq**（重置事件在逻辑上最近），而非末位注册事件——
  // 注册顺序可能与 seq 乱序（如恢复历史台账时晚注册了早先的重置）。
  const lastResetSeq = Math.max(...ledger.events.map(entry => entry.seq))
  // 仅当最近重置事件**严格晚于**上一状态（prev.seq < lastResetSeq）才豁免。
  // 豁免语义 = 「本轮是该重置之后的第一个请求（warm-up 轮，命中率计域外）」。
  // 相等边界（lastResetSeq === prev.seq，重置与上一 GuardState 捕获于同一
  // seq）刻意用 `<` 而非 `<=`，是**保守方向**的有意选择：此时无法判定 prev
  // 是否已包含该重置（prev 可能已是重置后落盘的状态），故不豁免、仍要求
  // 前缀单调成立——避免把「重置后本应连续的普通轮」纳入豁免窗口，从而漏检
  // 真实的前缀断裂。宁可少豁免（假阴性方向、可被后续轮补判），不可多豁免
  // （放过真实断裂）。该相等边界由 spec「上一状态与重置同 seq → 不豁免」用例锁定。
  if (prev.seq < lastResetSeq) return { ok: true }
  return result
}

// ---------------------------------------------------------------------------
// 3. 重置事件白名单台账
// ---------------------------------------------------------------------------

/** 重置事件类型白名单（L5：换模型/变体 | 压缩 | 合并重写 | 微剪枝 | 工具集变更 | 系统节变更 | 会话恢复 | 一次性豁免）。 */
export const RESET_EVENT_TYPES = [
  'modelChange',
  'compaction',
  'mergeRewrite',
  'microPrune',
  'toolsetChange',
  'systemSectionChange',
  'sessionRecovery',
  'oneShotExempt',
] as const

/** 重置事件类型。 */
export type ResetEventType = typeof RESET_EVENT_TYPES[number]

const ALLOWED_RESET_TYPES: ReadonlySet<string> = new Set<string>(RESET_EVENT_TYPES)

/** 台账中的一条重置事件记录。 */
export interface ResetEventEntry {
  readonly type: ResetEventType
  /** 事件在会话日志中的 seq 编号。 */
  readonly seq: number
  /** 注册时间戳（Unix epoch ms）。 */
  readonly timestamp: number
}

/** 完整的重置事件台账（带 seq 持久化的追加式列表）。 */
export interface ResetLedger {
  /** 按注册顺序排列的事件列表。 */
  readonly events: readonly ResetEventEntry[]
  /** 台账持久化代数：每次注册递增，用于校验持久化写入的完整性。 */
  readonly generation: number
}

/** 创建空的台账。 */
export function createResetLedger(): ResetLedger {
  return { events: [], generation: 0 }
}

/**
 * 注册一条重置事件（带 seq 持久化）。
 * @param ledger - 当前台账。
 * @param type - 重置事件类型。
 * @param seq - 事件在会话日志中的 seq 编号。
 * @returns 更新后的台账（generation 递增，事件追加在尾部）。
 */
export function registerResetEvent(
  ledger: ResetLedger,
  type: ResetEventType,
  seq: number,
): ResetLedger {
  return {
    events: [...ledger.events, { type, seq, timestamp: Date.now() }],
    generation: ledger.generation + 1,
  }
}

/**
 * 检查事件类型是否属于重置白名单。
 * @param type - 待检查的类型。
 * @returns 是否为允许的重置类型。
 */
export function isAllowedReset(type: string): type is ResetEventType {
  return ALLOWED_RESET_TYPES.has(type)
}

/**
 * 序列化台账为 JSON 字符串（Phase 6 持久化用）。只保留可重建字段
 * （events + generation），不携带运行时态。
 * @param ledger - 待序列化的台账。
 * @returns 稳定 JSON 字符串（键序固定）。
 */
export function serializeLedger(ledger: ResetLedger): string {
  return JSON.stringify({
    generation: ledger.generation,
    events: ledger.events.map(entry => ({
      type: entry.type,
      seq: entry.seq,
      timestamp: entry.timestamp,
    })),
  })
}

/**
 * 从 JSON 字符串重建台账。任何形状不符（非对象、事件类型不在白名单、
 * seq/timestamp 非有限数、generation 非非负整数）都返回 undefined，
 * 调用方按「无台账」处理（新建空台账）。
 * @param serialized - {@link serializeLedger} 的输出，或任意损坏字符串。
 * @returns 重建的台账；无法解析时返回 undefined。
 */
export function deserializeLedger(serialized: string): ResetLedger | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const rawEvents = record['events']
  const rawGeneration = record['generation']
  if (!Array.isArray(rawEvents)) return undefined
  if (typeof rawGeneration !== 'number' || !Number.isSafeInteger(rawGeneration) || rawGeneration < 0) {
    return undefined
  }
  const events: ResetEventEntry[] = []
  for (const raw of rawEvents) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const entry = raw as Record<string, unknown>
    const type = entry['type']
    const seq = entry['seq']
    const timestamp = entry['timestamp']
    if (typeof type !== 'string' || !isAllowedReset(type)) return undefined
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) return undefined
    events.push({ type, seq, timestamp })
  }
  return { events, generation: rawGeneration }
}

/**
 * 一次性请求显式豁免判定：全新 sessionId 且 sessionId 与上一请求不同
 * （L0 豁免域 (a)：一次性请求——fresh sessionId 恒 0 命中）。
 *
 * 不再要求 system prompt 与上一请求不同（P56 建议 4）：fresh session 的
 * 首个请求不可能复用任何缓存前缀，豁免与否与 system prompt 是否变化无关。
 * @param freshSessionId - 是否为全新会话（无先前缓存）。
 * @param sessionIdDiffers - sessionId 是否与上一请求的 sessionId 不同。
 * @returns 是否为一次性请求（应豁免）。
 */
export function isOneShotExempt(
  freshSessionId: boolean,
  sessionIdDiffers: boolean,
): boolean {
  return freshSessionId && sessionIdDiffers
}

// ---------------------------------------------------------------------------
// 4. per-provider κ/η 参数
// ---------------------------------------------------------------------------

/** 缓存经济学参数（成本方程 §0：C × (1 − r + r·κ) + Σ w·η）。 */
export interface CacheEconomics {
  /** 缓存折扣因子 κ：命中 token 的实际计费比例。 */
  readonly kappa: number
  /** 写入价格乘数 η：短 TTL 1.25×，1h 长 TTL 2×。 */
  readonly eta: number
  /** TTL 策略：short（5m）/ long（1h）。 */
  readonly ttl: 'short' | 'long'
}

/**
 * 解析 provider 的缓存经济学参数。
 *
 * - Anthropic/DeepSeek：κ = 0.1（缓存命中 token 仅计 10%）
 * - OpenAI：κ = 0.5
 * - 未知 provider：κ = 0.5（保守默认，按较低折扣估计）
 * - η：短 TTL 1.25，长 TTL 2；TTL 默认短（5m），1h 仅显式开启。
 *
 * @param provider - provider 路由键（大小写不敏感）。
 * @param ttl - TTL 策略，默认 'short'。
 * @returns 该 provider 的 κ/η 参数。
 */
export function resolveCacheEconomics(
  provider: string,
  ttl: 'short' | 'long' = 'short',
): CacheEconomics {
  const lower = provider.toLowerCase()
  const kappa = lower.includes('anthropic') || lower.includes('claude') || lower.includes('deepseek')
    ? 0.1
    : 0.5
  return { kappa, eta: ttl === 'long' ? 2.0 : 1.25, ttl }
}

// ---------------------------------------------------------------------------
// 5. 重置事件记账
// ---------------------------------------------------------------------------

/**
 * 计算一次重置事件的缓存写入成本：η × contextTokens。
 *
 * 该值即成本方程 §0 第二项的写入分量 `w·η`（重置事件全量重写）。
 * 调用方将返回值折入会话台账的 `resetWriteTokens` 累计字段
 * （token-meter `CacheMetricsProjection`，经其 `foldResetWriteCost` 纯函数对接）。
 *
 * @param contextTokens - 重置时点的上下文 token 数。
 * @param eta - 写入价格乘数（见 {@link resolveCacheEconomics}）。
 * @returns 写入成本（token 当量，四舍五入取整）。
 */
export function accountResetCost(contextTokens: number, eta: number): number {
  if (!Number.isFinite(contextTokens) || contextTokens < 0) return 0
  if (!Number.isFinite(eta) || eta < 0) return 0
  return Math.round(contextTokens * eta)
}
