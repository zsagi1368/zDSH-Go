/**
 * L5 cache-guardian: three-segment normalized hashing, monotonic extension
 * check, reset-event whitelist ledger, per-provider κ/η economics, and
 * reset-event cost accounting.
 *
 * @module dsh-llm-pi-ai/tests/cache-guardian
 */

import { describe, expect, it } from 'vitest'
import type {
  AssistantMessage,
  Context as PiContext,
  ImageContent,
  Tool as PiTool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai'
import {
  accountResetCost,
  computeGuardState,
  createResetLedger,
  deserializeLedger,
  hashSegment,
  isAllowedReset,
  isOneShotExempt,
  registerResetEvent,
  resolveCacheEconomics,
  serializeLedger,
  stableStringify,
  verifyMonotonic,
  verifyMonotonicWithReset,
} from '../src/cache-guardian.ts'

function usage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: usage(),
    stopReason: 'stop',
    timestamp: 0,
  }
}

function context(overrides: Partial<PiContext> = {}): PiContext {
  return {
    systemPrompt: 'be helpful',
    messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
    tools: [{ name: 'Read', description: 'read a file', parameters: { type: 'object' } }],
    ...overrides,
  }
}

function tool(name: string, description = 'tool description'): PiTool {
  return { name, description, parameters: { type: 'object' } }
}

function toolResult(
  content: (ImageContent | { type: 'text'; text: string })[],
  overrides: Partial<ToolResultMessage> = {},
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'Read',
    content,
    isError: false,
    timestamp: 0,
    ...overrides,
  }
}

function image(): ImageContent {
  return { type: 'image', data: 'base64data', mimeType: 'image/png' }
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown> | undefined,
): ToolCall {
  return { type: 'toolCall', id, name, arguments: args } as ToolCall
}

describe('three-segment normalized hashing', () => {
  it('is invariant under cache_control/ttl injection on the last text block', () => {
    const plain = context({ messages: [
      { role: 'user', content: 'hello', timestamp: 0 },
      { role: 'user', content: 'world', timestamp: 0 },
    ] })
    // Simulate the adapter injecting cache_control on the trailing user block.
    const injected = context({ messages: [
      { role: 'user', content: 'hello', timestamp: 0 },
      {
        role: 'user',
        content: [{
          type: 'text',
          text: 'world',
          cache_control: { type: 'ephemeral', ttl: '5m' },
        } as never],
        timestamp: 0,
      },
    ] })

    expect(computeGuardState(plain).messagesHash).toBe(computeGuardState(injected).messagesHash)
    expect(computeGuardState(plain)).toEqual(computeGuardState(injected))
  })

  it('is invariant under cache_control/ttl injection on tools', () => {
    const plain = context({ tools: [tool('Read'), tool('Bash')] })
    const injected = context({
      tools: [{
        ...tool('Read'),
        cache_control: { type: 'ephemeral', ttl: '1h' },
      } as unknown as PiTool, tool('Bash')],
    })
    expect(computeGuardState(plain).toolsHash).toBe(computeGuardState(injected).toolsHash)
  })

  it('strips empty text blocks and empty messages', () => {
    const withEmpty = context({ messages: [
      { role: 'user', content: 'hello', timestamp: 0 },
      { role: 'user', content: '   ', timestamp: 0 }, // dropped
    ] })
    const withoutEmpty = context({ messages: [
      { role: 'user', content: 'hello', timestamp: 0 },
    ] })
    expect(computeGuardState(withEmpty).messagesHash).toBe(computeGuardState(withoutEmpty).messagesHash)
  })

  it('deterministically downgrades signature-less thinking to text', () => {
    // thinking without a signature must hash identically to the same text block
    const asThinking = context({ messages: [
      assistant([{ type: 'thinking', thinking: 'private reasoning' }]),
    ] })
    const asText = context({ messages: [
      assistant([{ type: 'text', text: 'private reasoning' }]),
    ] })
    expect(computeGuardState(asThinking).messagesHash).toBe(computeGuardState(asText).messagesHash)
  })

  it('keeps signed thinking distinct from downgraded text', () => {
    const signed = context({ messages: [
      assistant([{ type: 'thinking', thinking: 'reason', thinkingSignature: 'sig-1' }]),
    ] })
    const unsigned = context({ messages: [
      assistant([{ type: 'thinking', thinking: 'reason' }]),
    ] })
    expect(computeGuardState(signed).messagesHash).not.toBe(computeGuardState(unsigned).messagesHash)
  })

  it('maps OAuth Claude Code tool names case-insensitively', () => {
    const canonical = context({ tools: [tool('Read'), tool('Bash')] })
    const lowercase = context({ tools: [tool('read'), tool('bash')] })
    expect(computeGuardState(canonical).toolsHash).toBe(computeGuardState(lowercase).toolsHash)
    // Tool names in tool calls are mapped too.
    const callCanonical = context({ messages: [
      assistant([{ type: 'toolCall', id: 'c1', name: 'Read', arguments: {} }]),
    ] })
    const callLowercase = context({ messages: [
      assistant([{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }]),
    ] })
    expect(computeGuardState(callCanonical).messagesHash).toBe(computeGuardState(callLowercase).messagesHash)
  })

  it('sanitizes unpaired surrogates before hashing', () => {
    const dirty = context({ systemPrompt: 'be helpful\uD800' })
    const clean = context({ systemPrompt: 'be helpful' })
    expect(computeGuardState(dirty).systemHash).toBe(computeGuardState(clean).systemHash)
  })

  it('is deterministic across identical contexts and detects tool reordering', () => {
    const first = context({ tools: [tool('Read'), tool('Bash')] })
    const identical = context({ tools: [tool('Read'), tool('Bash')] })
    const reordered = context({ tools: [tool('Bash'), tool('Read')] })
    expect(computeGuardState(first)).toEqual(computeGuardState(identical))
    // pi convertTools 保序（tools.map，anthropic-messages.ts:1336），Anthropic
    // 缓存对 tools 顺序敏感：重排必须判为变化（V2 返工，反转旧 tool-order-ignored）。
    expect(computeGuardState(first).toolsHash).not.toBe(computeGuardState(reordered).toolsHash)
  })

  it('hashes each segment independently via hashSegment', () => {
    const plain = context({})
    expect(hashSegment('system', plain.systemPrompt)).toBe(computeGuardState(plain).systemHash)
    expect(hashSegment('tools', plain.tools)).toBe(computeGuardState(plain).toolsHash)
    expect(hashSegment('messages', plain.messages)).toBe(computeGuardState(plain).messagesHash)
  })

  it('normalizes an absent system prompt and empty tools/messages to stable hashes', () => {
    const bare: PiContext = { messages: [] }
    const state = computeGuardState(bare)
    expect(state.systemHash).toBe(hashSegment('system', undefined))
    expect(state.toolsHash).toBe(hashSegment('tools', undefined))
    expect(state.messagesHash).toBe(hashSegment('messages', []))
    expect(state.messageHashes).toEqual([])
  })

  it('produces stable canonical serialization', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(undefined)).toBe('null')
    expect(stableStringify([3, { x: 1 }, 's'])).toBe('[3,{"x":1},"s"]')
  })
})

// ---------------------------------------------------------------------------
// pi-fidelity：逐条对照 pi-ai 0.82.1 convertMessages / convertContentBlocks /
// convertTools 的真实 wire 行为断言（V2 返工新增，防止偏差固化为期望）。
// 行号均指 packages/ai/src/api/anthropic-messages.ts。
// ---------------------------------------------------------------------------

describe('pi-fidelity: tools segment', () => {
  it('preserves tool order like pi convertTools (reorder = cache break)', () => {
    const ab = computeGuardState(context({ tools: [tool('Alpha'), tool('Beta')] })).toolsHash
    const ba = computeGuardState(context({ tools: [tool('Beta'), tool('Alpha')] })).toolsHash
    expect(ab).not.toBe(ba)
  })

  it('hashes parameters as {properties,required} only (pi legacyInputSchema :1339-1351)', () => {
    const base = tool('Read')
    const withExtras = {
      ...base,
      parameters: {
        type: 'object',
        properties: { p: { type: 'string' } },
        required: ['p'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    } as unknown as PiTool
    const filtered = {
      ...base,
      parameters: { properties: { p: { type: 'string' } }, required: ['p'] },
    } as unknown as PiTool
    const differentProps = {
      ...base,
      parameters: { properties: { p: { type: 'number' } }, required: ['p'] },
    } as unknown as PiTool
    // 顶层附加键不进 pi wire（非 strict 路径）→ 不进哈希。
    expect(computeGuardState(context({ tools: [withExtras] })).toolsHash)
      .toBe(computeGuardState(context({ tools: [filtered] })).toolsHash)
    // properties 变化进 wire → 必须进哈希。
    expect(computeGuardState(context({ tools: [filtered] })).toolsHash)
      .not.toBe(computeGuardState(context({ tools: [differentProps] })).toolsHash)
  })
})

describe('pi-fidelity: messages segment', () => {
  it('system prompt whitespace is significant (pi does not trim, :1021/:1030)', () => {
    const trimmed = computeGuardState(context({ systemPrompt: 'be helpful' })).systemHash
    const padded = computeGuardState(context({ systemPrompt: ' be helpful' })).systemHash
    expect(trimmed).not.toBe(padded)
  })

  it('user string of only unpaired surrogates stays on the wire (pi blank-check is on raw, :1171)', () => {
    // pi：raw trim 长度 1 > 0 → 发送清理后的空串；guard 不得提前丢整条。
    const lone = computeGuardState(context({
      messages: [{ role: 'user', content: '\uD800', timestamp: 0 }],
    }))
    expect(lone.messageHashes).toHaveLength(1)
  })

  it('toolCall id is hashed (pi sends tool_use.id, :1255)', () => {
    const callA = context({ messages: [assistant([toolCall('call-1', 'Read', { f: 'x' })])] })
    const callB = context({ messages: [assistant([toolCall('call-2', 'Read', { f: 'x' })])] })
    expect(computeGuardState(callA).messagesHash).not.toBe(computeGuardState(callB).messagesHash)
  })

  it('missing toolCall arguments hash like pi-sent empty input (arguments ?? {}, :1257)', () => {
    const noArgs = context({ messages: [assistant([toolCall('c1', 'Read', undefined)])] })
    const emptyArgs = context({ messages: [assistant([toolCall('c1', 'Read', {})])] })
    expect(computeGuardState(noArgs).messagesHash).toBe(computeGuardState(emptyArgs).messagesHash)
  })

  it('stopReason does not affect the hash (pi request body omits it, :1262-1265)', () => {
    const stop = assistant([{ type: 'text', text: 'hi' }])
    const toolUse: AssistantMessage = { ...stop, stopReason: 'toolUse' }
    expect(computeGuardState(context({ messages: [stop] })).messagesHash)
      .toBe(computeGuardState(context({ messages: [toolUse] })).messagesHash)
  })

  it('redacted thinking hashes as opaque payload (pi redacted_thinking{data}, :1219-1225)', () => {
    const redactedA = context({ messages: [assistant([
      { type: 'thinking', thinking: '', thinkingSignature: 'opaque-1', redacted: true },
    ])] })
    const redactedB = context({ messages: [assistant([
      { type: 'thinking', thinking: '', thinkingSignature: 'opaque-2', redacted: true },
    ])] })
    const signedPlain = context({ messages: [assistant([
      { type: 'thinking', thinking: '', thinkingSignature: 'opaque-1' },
    ])] })
    // 不透明载荷变化必须可检（漏检方向修复）。
    expect(computeGuardState(redactedA).messagesHash)
      .not.toBe(computeGuardState(redactedB).messagesHash)
    // redacted_thinking 与 thinking{signature} 是不同 wire 块类型。
    expect(computeGuardState(redactedA).messagesHash)
      .not.toBe(computeGuardState(signedPlain).messagesHash)
    // 病态输入（对齐 pi :1222 `thinkingSignature!` 运行时语义）：redacted 但
    // 签名缺失（undefined）与签名空串（''）在 pi wire 上是两种字节——
    // `{"type":"redacted_thinking"}`（data 键被 JSON 丢弃）vs
    // `{"type":"redacted_thinking","data":""}`。去掉 `?? ''` 兜底后 guard 必须
    // 区分二者（stableStringify：undefined→null、''→""）；旧 `?? ''` 会折叠为
    // 同一哈希，是相对 pi 的漏检偏差，此断言锁定修复。
    const redactedNoSig = context({ messages: [assistant([
      { type: 'thinking', thinking: '', redacted: true },
    ])] })
    const redactedEmptySig = context({ messages: [assistant([
      { type: 'thinking', thinking: '', thinkingSignature: '', redacted: true },
    ])] })
    expect(computeGuardState(redactedNoSig).messagesHash)
      .not.toBe(computeGuardState(redactedEmptySig).messagesHash)
  })

  it('allowEmptySignature mirrors the pi compat branch (:1232-1244)', () => {
    const unsigned = context({ messages: [assistant([
      { type: 'thinking', thinking: 'reason' },
    ])] })
    const asText = context({ messages: [assistant([{ type: 'text', text: 'reason' }])] })
    const downgraded = computeGuardState(unsigned)
    const preserved = computeGuardState(unsigned, undefined, { allowEmptySignature: true })
    // 默认（false）：降级为 text，与文本块同哈希（pi :1240-1243）。
    expect(downgraded.messagesHash).toBe(computeGuardState(asText).messagesHash)
    // compat=true：保留 thinking{signature:''}（pi :1234-1239），两种 wire 不同。
    expect(preserved.messagesHash).not.toBe(downgraded.messagesHash)
    expect(preserved.messagesHash).not.toBe(computeGuardState(asText).messagesHash)
  })

  it('toolResult text blocks join with \\n and empty blocks are kept (:131-135)', () => {
    const twoBlocks = context({ messages: [toolResult([
      { type: 'text', text: 'a' }, { type: 'text', text: 'b' },
    ])] })
    const joined = context({ messages: [toolResult([{ type: 'text', text: 'a\nb' }])] })
    expect(computeGuardState(twoBlocks).messagesHash).toBe(computeGuardState(joined).messagesHash)
    // 空块不剔除：['a',''] → 'a\n' ≠ 'a'（旧实现剔空会误判相等）。
    const withEmpty = context({ messages: [toolResult([
      { type: 'text', text: 'a' }, { type: 'text', text: '' },
    ])] })
    const single = context({ messages: [toolResult([{ type: 'text', text: 'a' }])] })
    expect(computeGuardState(withEmpty).messagesHash).not.toBe(computeGuardState(single).messagesHash)
    expect(computeGuardState(withEmpty).messagesHash).not.toBe(computeGuardState(joined).messagesHash)
  })

  it('toolResult with empty content is never dropped from the chain (:1137-1145)', () => {
    const empty = computeGuardState(context({ messages: [toolResult([])] }))
    const blank = computeGuardState(context({ messages: [toolResult([{ type: 'text', text: '' }])] }))
    expect(empty.messageHashes).toHaveLength(1)
    // pi：join([])==='' 与 join([''])==='' 同 wire。
    expect(empty.messagesHash).toBe(blank.messagesHash)
  })

  it('toolResult with images follows the pi placeholder rule (:155-162)', () => {
    const onlyImage = context({ messages: [toolResult([image()])] })
    const withPlaceholder = context({ messages: [toolResult([
      { type: 'text', text: '(see attached image)' }, image(),
    ])] })
    expect(computeGuardState(onlyImage).messagesHash)
      .toBe(computeGuardState(withPlaceholder).messagesHash)
    // 空 text 块保留 → hasText 为真 → 不补占位，与纯 image 不同。
    const imagePlusEmptyText = context({ messages: [toolResult([
      image(), { type: 'text', text: '' },
    ])] })
    expect(computeGuardState(imagePlusEmptyText).messagesHash)
      .not.toBe(computeGuardState(onlyImage).messagesHash)
  })
})

describe('monotonic extension check', () => {
  const makeState = (text: string, seq: number) => computeGuardState(
    context({ messages: [{ role: 'user', content: text, timestamp: 0 }] }),
    seq,
  )

  it('passes when the next round only appends to the tail', () => {
    const prev = context({ messages: [
      { role: 'user', content: 'first', timestamp: 0 },
    ] })
    const next = context({ messages: [
      { role: 'user', content: 'first', timestamp: 0 },
      assistant([{ type: 'text', text: 'answer' }]),
    ] })
    expect(verifyMonotonic(computeGuardState(prev), computeGuardState(next))).toEqual({ ok: true })
  })

  it('passes for an unchanged round', () => {
    const state = computeGuardState(context({}))
    expect(verifyMonotonic(state, state)).toEqual({ ok: true })
  })

  it('fails when a message is rewritten in place (mid-history edit)', () => {
    const prev = context({ messages: [
      { role: 'user', content: 'original', timestamp: 0 },
      assistant([{ type: 'text', text: 'answer' }]),
    ] })
    const rewritten = context({ messages: [
      { role: 'user', content: 'EDITED', timestamp: 0 },
      assistant([{ type: 'text', text: 'answer' }]),
    ] })
    const result = verifyMonotonic(computeGuardState(prev), computeGuardState(rewritten))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('index 0')
  })

  it('fails when the messages segment shrank', () => {
    const prev = context({ messages: [
      { role: 'user', content: 'a', timestamp: 0 },
      { role: 'user', content: 'b', timestamp: 0 },
    ] })
    const shrank = context({ messages: [
      { role: 'user', content: 'a', timestamp: 0 },
    ] })
    const result = verifyMonotonic(computeGuardState(prev), computeGuardState(shrank))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('shrank')
  })

  it('fails when the system segment changes', () => {
    const prev = context({ systemPrompt: 'original system' })
    const changed = context({ systemPrompt: 'changed system' })
    const result = verifyMonotonic(computeGuardState(prev), computeGuardState(changed))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('system')
  })

  it('fails when the tools segment changes', () => {
    const prev = context({ tools: [tool('Read')] })
    const changed = context({ tools: [tool('Read'), tool('Write')] })
    const result = verifyMonotonic(computeGuardState(prev), computeGuardState(changed))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('tools')
  })

  it('exempts a rewrite when a whitelisted reset event is registered', () => {
    const prev = computeGuardState(context({ messages: [
      { role: 'user', content: 'original', timestamp: 0 },
    ] }))
    const rewritten = computeGuardState(context({ messages: [
      { role: 'user', content: 'EDITED', timestamp: 0 },
    ] }))
    // Pure check fails…
    expect(verifyMonotonic(prev, rewritten).ok).toBe(false)
    // …but a registered compaction reset event exempts it (prev.seq 缺省 →
    // 旧行为：非空白名单台账即豁免)。
    const ledger = registerResetEvent(createResetLedger(), 'compaction', 7)
    expect(verifyMonotonicWithReset(prev, rewritten, ledger)).toEqual({ ok: true })
  })

  it('does not exempt a rewrite when the ledger is empty', () => {
    const prev = computeGuardState(context({ messages: [
      { role: 'user', content: 'original', timestamp: 0 },
    ] }))
    const rewritten = computeGuardState(context({ messages: [
      { role: 'user', content: 'EDITED', timestamp: 0 },
    ] }))
    expect(verifyMonotonicWithReset(prev, rewritten, createResetLedger())).toMatchObject({ ok: false })
  })

  it('exempts only the first request after the last reset when seqs are carried (P56 建议 3)', () => {
    const ledger = registerResetEvent(createResetLedger(), 'compaction', 7)

    // 重置（seq 7）发生在上一状态（seq 5）之后 → 本轮是重置后第一个请求 → 豁免。
    const prevBefore = makeState('original', 5)
    const nextAfter = makeState('EDITED', 9)
    expect(verifyMonotonic(prevBefore, nextAfter).ok).toBe(false)
    expect(verifyMonotonicWithReset(prevBefore, nextAfter, ledger)).toEqual({ ok: true })

    // 上一状态（seq 8）在重置（seq 7）之后 → 本轮不是重置后第一个请求 → 不豁免。
    const prevAfter = makeState('original', 8)
    const nextLater = makeState('EDITED', 12)
    expect(verifyMonotonicWithReset(prevAfter, nextLater, ledger)).toMatchObject({ ok: false })

    // 上一状态与重置同 seq 之后（seq 7 = 重置 seq，状态仍晚于重置前）→ 不豁免。
    const prevAtReset = makeState('original', 7)
    expect(verifyMonotonicWithReset(prevAtReset, nextLater, ledger)).toMatchObject({ ok: false })
  })

  it('keeps the exemption window open for a monotonic pass and closes it for later rewrites', () => {
    // 连续两次重置：台账以最近一次（seq 11）为准。
    const ledger = registerResetEvent(
      registerResetEvent(createResetLedger(), 'compaction', 3),
      'mergeRewrite',
      11,
    )

    // 上一状态在最近重置（11）之前 → 豁免。
    const prevBefore = makeState('original', 9)
    const rewritten = makeState('EDITED', 13)
    expect(verifyMonotonicWithReset(prevBefore, rewritten, ledger)).toEqual({ ok: true })

    // 上一状态在最近重置（11）之后 → 窗口关闭，不再豁免。
    const prevAfter = makeState('original', 12)
    const rewrittenLater = makeState('EDITED-again', 15)
    expect(verifyMonotonicWithReset(prevAfter, rewrittenLater, ledger)).toMatchObject({ ok: false })
  })

  it('exempts by the max-seq reset event when registrations arrive out of order (V13)', () => {
    // 注册顺序与 seq 乱序：先注册 seq 11，后注册 seq 3（如台账恢复场景）。
    const ledger = registerResetEvent(
      registerResetEvent(createResetLedger(), 'compaction', 11),
      'mergeRewrite',
      3,
    )
    // prev.seq 9 早于最大 seq 重置（11）→ 豁免。旧实现取末位注册事件
    // （seq 3）会误判为不豁免，放过真实重置窗口 / 错杀正常轮，此处固化 max-seq 语义。
    expect(verifyMonotonicWithReset(makeState('original', 9), makeState('EDITED', 13), ledger))
      .toEqual({ ok: true })
    // prev.seq 12 晚于最大 seq 重置（11）→ 窗口关闭，不豁免。
    expect(verifyMonotonicWithReset(makeState('original', 12), makeState('EDITED', 15), ledger))
      .toMatchObject({ ok: false })
  })

  it('does not exempt when the ledger holds only unknown (non-whitelisted) reset types', () => {
    const prev = computeGuardState(context({ messages: [
      { role: 'user', content: 'original', timestamp: 0 },
    ] }), 5)
    const rewritten = computeGuardState(context({ messages: [
      { role: 'user', content: 'EDITED', timestamp: 0 },
    ] }), 9)
    // 手工构造一条白名单外事件（绕过 registerResetEvent 的类型约束）。
    const ledger = { events: [{ type: 'mystery-reset' as never, seq: 7, timestamp: 0 }], generation: 1 }
    expect(verifyMonotonicWithReset(prev, rewritten, ledger)).toMatchObject({ ok: false })
  })
})

describe('reset-event whitelist ledger', () => {
  it('starts empty with generation zero', () => {
    const ledger = createResetLedger()
    expect(ledger.events).toEqual([])
    expect(ledger.generation).toBe(0)
  })

  it('registers events with seq and bumps the generation, leaving prior entries intact', () => {
    const first = registerResetEvent(createResetLedger(), 'modelChange', 3)
    expect(first.events).toEqual([{ type: 'modelChange', seq: 3, timestamp: expect.any(Number) as number }])
    expect(first.generation).toBe(1)

    const second = registerResetEvent(first, 'compaction', 9)
    expect(second.events).toHaveLength(2)
    expect(second.events[0]).toEqual(first.events[0]) // persisted prefix unchanged
    expect(second.events[1]).toMatchObject({ type: 'compaction', seq: 9 })
    expect(second.generation).toBe(2)
    // Original ledger is immutable (persistable snapshot).
    expect(first.events).toHaveLength(1)
    expect(first.generation).toBe(1)
  })

  it('accepts every whitelisted reset type and rejects unknown ones', () => {
    for (const type of ['modelChange', 'compaction', 'mergeRewrite', 'microPrune',
      'toolsetChange', 'systemSectionChange', 'sessionRecovery', 'oneShotExempt'] as const) {
      expect(isAllowedReset(type)).toBe(true)
    }
    expect(isAllowedReset('mystery-reset')).toBe(false)
    expect(isAllowedReset('')).toBe(false)
  })

  it('exempts one-shot requests when the session is fresh and its id differs from the previous (P56 建议 4)', () => {
    // 只需 fresh sessionId + sessionId 与上一请求不同；不再要求 systemPromptChanged。
    expect(isOneShotExempt(true, true)).toBe(true)
    // fresh session 但 sessionId 与上一请求相同 → 可能复用缓存 → 不豁免。
    expect(isOneShotExempt(true, false)).toBe(false)
    expect(isOneShotExempt(false, true)).toBe(false)
    expect(isOneShotExempt(false, false)).toBe(false)
  })
})

describe('per-provider cache economics', () => {
  it('assigns κ=0.1 to Anthropic and DeepSeek with short-TTL η=1.25 by default', () => {
    expect(resolveCacheEconomics('anthropic')).toEqual({ kappa: 0.1, eta: 1.25, ttl: 'short' })
    expect(resolveCacheEconomics('deepseek')).toEqual({ kappa: 0.1, eta: 1.25, ttl: 'short' })
    expect(resolveCacheEconomics('Claude')).toMatchObject({ kappa: 0.1 })
  })

  it('assigns κ=0.5 to OpenAI', () => {
    expect(resolveCacheEconomics('openai')).toEqual({ kappa: 0.5, eta: 1.25, ttl: 'short' })
  })

  it('falls back to a conservative κ=0.5 for unknown providers', () => {
    expect(resolveCacheEconomics('acme-gateway')).toMatchObject({ kappa: 0.5 })
  })

  it('uses η=2.0 for long TTL and η=1.25 for short TTL', () => {
    expect(resolveCacheEconomics('anthropic', 'long')).toMatchObject({ eta: 2.0, ttl: 'long' })
    expect(resolveCacheEconomics('openai', 'long')).toMatchObject({ eta: 2.0 })
    expect(resolveCacheEconomics('deepseek', 'short')).toMatchObject({ eta: 1.25, ttl: 'short' })
  })
})

describe('reset-event cost accounting', () => {
  it('computes η × contextTokens', () => {
    expect(accountResetCost(1000, 1.25)).toBe(1250)
    expect(accountResetCost(1000, 2.0)).toBe(2000)
    expect(accountResetCost(0, 1.25)).toBe(0)
  })

  it('rejects non-finite or negative inputs with zero', () => {
    expect(accountResetCost(Number.NaN, 1.25)).toBe(0)
    expect(accountResetCost(-100, 1.25)).toBe(0)
    expect(accountResetCost(1000, Number.NaN)).toBe(0)
    expect(accountResetCost(1000, -1)).toBe(0)
  })
})

describe('ledger serialization (Phase 6 persistence)', () => {
  it('round-trips a ledger through serialize/deserialize', () => {
    const ledger = registerResetEvent(
      registerResetEvent(createResetLedger(), 'compaction', 7),
      'mergeRewrite',
      12,
    )
    const restored = deserializeLedger(serializeLedger(ledger))
    expect(restored).toEqual(ledger)
    expect(restored?.generation).toBe(2)
    expect(restored?.events).toHaveLength(2)
  })

  it('serializes with a stable key order and omits no fields', () => {
    const ledger = registerResetEvent(createResetLedger(), 'compaction', 3)
    const serialized = serializeLedger(ledger)
    // 键序固定（generation 在 events 前），事件字段齐全（type/seq/timestamp）。
    expect(serialized).toBe(JSON.stringify({
      generation: 1,
      events: [{
        type: 'compaction',
        seq: 3,
        timestamp: ledger.events[0]!.timestamp,
      }],
    }))
  })

  it('returns undefined for corrupt or malformed payloads', () => {
    expect(deserializeLedger('not json')).toBeUndefined()
    expect(deserializeLedger('null')).toBeUndefined()
    expect(deserializeLedger('[]')).toBeUndefined()
    expect(deserializeLedger(JSON.stringify({ generation: 0 }))).toBeUndefined()
    expect(deserializeLedger(JSON.stringify({ generation: -1, events: [] }))).toBeUndefined()
    expect(deserializeLedger(JSON.stringify({ generation: 0, events: 'x' }))).toBeUndefined()
    expect(deserializeLedger(JSON.stringify({ generation: 0, events: [{}] }))).toBeUndefined()
    expect(deserializeLedger(JSON.stringify({
      generation: 0,
      events: [{ type: 'mystery-reset', seq: 1, timestamp: 0 }],
    }))).toBeUndefined()
    expect(deserializeLedger(JSON.stringify({
      generation: 0,
      events: [{ type: 'compaction', seq: -1, timestamp: 0 }],
    }))).toBeUndefined()
    expect(deserializeLedger(JSON.stringify({
      generation: 0,
      events: [{ type: 'compaction', seq: 1, timestamp: Number.NaN }],
    }))).toBeUndefined()
  })

  it('keeps an empty ledger serializable and reconstructable', () => {
    const restored = deserializeLedger(serializeLedger(createResetLedger()))
    expect(restored).toEqual({ events: [], generation: 0 })
  })
})

describe('guard-state seq (exemption window input)', () => {
  it('carries the seq when provided and omits it when absent', () => {
    const plain = computeGuardState(context({}))
    expect(plain.seq).toBeUndefined()
    expect(computeGuardState(context({}), 42).seq).toBe(42)
    expect(computeGuardState(context({}), 42).messagesHash).toBe(plain.messagesHash)
  })
})
