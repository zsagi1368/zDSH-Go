import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { RuntimeContextProjection } from '../src/runtime-context.ts'

const SOURCE = '@deepseek-ai/dsh-system-prompt'
const CLEARED_TEXT = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function textOfMessage(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

async function makeSession(id: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId(id))
  return { ctx, session }
}

/** Append one tool result pair (log-only call + surface result) and return its seq. */
function appendToolResult(session: Session, callId: string, text: string): SessionSeq {
  const call = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: ToolCallId(callId),
    name: 'tool',
    arguments: '{}',
  })
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text }], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] }).seq
}

describe('RuntimeContextProjection (L2 delta protocol)', () => {
  it('registers deltas for state changes without producing full snapshot user messages', async () => {
    const { ctx, session } = await makeSession('delta-register')
    const projection = new RuntimeContextProjection(ctx, session)

    // 首次登记：整段当前上下文作为首条 delta（等价旧行为的首个完整快照），
    // 但不产生任何 user/message 事件。
    projection.register('Current runtime context.\n\nMode: read-only.', [{ name: 'policy', text: 'Mode: read-only.' }])
    expect(session.snapshotEvents()).toHaveLength(0)
    expect(projection.pendingDeltaText()).toBe('Current runtime context.\n\nMode: read-only.')

    // 状态未变 → 无新 delta。
    projection.register('Current runtime context.\n\nMode: read-only.', [{ name: 'policy', text: 'Mode: read-only.' }])
    expect(projection.pendingDeltaText()).toBe('Current runtime context.\n\nMode: read-only.')

    // 状态变化 → 只登记变化节的增量文本，不登记完整快照。
    projection.register('Current runtime context.\n\nMode: danger-full-access.', [{ name: 'policy', text: 'Mode: danger-full-access.' }])
    expect(projection.pendingDeltaText()).toBe('Current runtime context.\n\nMode: read-only.\n\nMode: danger-full-access.')
    expect(projection.pendingDeltaText()).not.toContain('Current runtime context. This snapshot supersedes')

    // 上下文清空后再重建（即使状态与清空前相同）→ 重新登记为新 delta。
    projection.foldInto([userMessage('fold all')])
    projection.register('', [])
    expect(projection.pendingDeltaText()).toBe(CLEARED_TEXT)
    projection.register('Current runtime context.\n\nMode: read-only.', [{ name: 'policy', text: 'Mode: read-only.' }])
    expect(projection.pendingDeltaText()).toBe(`${CLEARED_TEXT}\n\nMode: read-only.`)
  })

  it('folds deltas into the next real user message; no isolated user(delta) on the wire', async () => {
    const { ctx, session } = await makeSession('delta-fold')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])

    const messages = projection.foldInto([userMessage('hello')])
    expect(messages).toHaveLength(1)
    expect(textOfMessage(messages[0]!)).toBe('C1\n\nhello')
    // wire 上不存在孤立 user(delta)：折叠消息是唯一消息，文本同时含 delta 与用户文本。
    expect(messages.some(message => textOfMessage(message) === 'C1')).toBe(false)
    // 折叠即消费。
    expect(projection.pendingDeltaText()).toBe('')
  })

  it('skips deltas already covered by tool results', async () => {
    const { ctx, session } = await makeSession('delta-covered')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])
    projection.foldInto([userMessage('first')])

    // 工具结果已经体现了新状态 → 该变更不入 delta。
    appendToolResult(session, 'c1', 'Mode: danger-full-access.')
    projection.register('C2', [{ name: 'policy', text: 'Mode: danger-full-access.' }])
    expect(projection.pendingDeltaText()).toBe('')

    // 工具结果未体现的变更仍正常登记。
    appendToolResult(session, 'c2', 'unrelated output')
    projection.register('C3', [{ name: 'policy', text: 'Mode: sandbox-only.' }])
    expect(projection.pendingDeltaText()).toBe('Mode: sandbox-only.')
  })

  it('keeps deltas pending during a tool loop without real user messages and reclaims them at the compaction boundary', async () => {
    const { ctx, session } = await makeSession('delta-loop-reclaim')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])

    // 长工具循环：assistant(tool_use) + toolResult，无真实 user 消息。
    const assistant = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 't1', arguments: '{}' }],
      source: { provider: 'mock', model: 'mock' },
    })
    const assistantSeq = session.append('assistant/message', { stream: [], turn: 1, step: 1, message: assistant }, { surfaceOp: 'append' }).seq
    const resultSeq = appendToolResult(session, 'c1', 'ok')

    // 工具上下文（plugin 源）不是真实 user 消息 → 折叠推迟，delta 不进视图。
    const pluginContext = createUserMessage({
      content: [{ type: 'text', text: 'tool context' }],
      source: { kind: 'plugin', plugin: 'test-tool' },
    })
    const deferred = projection.foldInto([pluginContext])
    expect(deferred[0]).toBe(pluginContext)
    expect(projection.pendingDeltaText()).not.toBe('')

    // 压缩替换覆盖该区间 → delta 区间被清空（随边界从发送视图消失）。
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted summary' }],
      source: { kind: 'plugin', plugin: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', start: assistantSeq, end: resultSeq },
      sourceEventSeqs: [assistantSeq, resultSeq],
    })
    expect(projection.pendingDeltaText()).toBe('')
    expect(projection.reclaimedUnfoldedChars()).toBeGreaterThan(0)
    expect(projection.reclaimedUnfoldedRanges()).toBe(1)

    // 压缩回收后，下一真实 user 消息不再折叠旧 delta。
    const after = projection.foldInto([userMessage('hello')])
    expect(textOfMessage(after[0]!)).toBe('hello')
  })

  it('preflight rejects an orphaned tool result and defers folding', async () => {
    const { ctx, session } = await makeSession('delta-preflight-orphan')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])

    // 非法序列：toolResult 不紧跟其 assistant(tool_use)。
    appendToolResult(session, 'c1', 'r1')
    const input = userMessage('hello')
    const deferred = projection.foldInto([input])
    expect(deferred[0]).toBe(input)
    expect(projection.pendingDeltaText()).not.toBe('')
  })

  it('preflight rejects a user sandwiched between tool results and defers folding', async () => {
    const { ctx, session } = await makeSession('delta-preflight-sandwich')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])

    // 合法工具批：assistant(tool_use) → toolResult。
    const assistant = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 't1', arguments: '{}' }],
      source: { provider: 'mock', model: 'mock' },
    })
    session.append('assistant/message', { stream: [], turn: 1, step: 1, message: assistant }, { surfaceOp: 'append' })
    appendToolResult(session, 'c1', 'r1')
    // user 紧邻 toolResult 之后还有 toolResult → 非法相邻对。
    session.append('user/message', userMessage('middle'), { surfaceOp: 'append' })
    appendToolResult(session, 'c2', 'r2')

    const input = userMessage('hello')
    const deferred = projection.foldInto([input])
    expect(deferred[0]).toBe(input)
    expect(projection.pendingDeltaText()).not.toBe('')
  })

  it('folds after a valid assistant predecessor when preflight passes', async () => {
    const { ctx, session } = await makeSession('delta-preflight-ok')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])
    session.append('assistant/message', { stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })

    const folded = projection.foldInto([userMessage('hello')])
    expect(textOfMessage(folded[0]!)).toBe('C1\n\nhello')
  })

  it('merges tail ranges over the threshold and registers a reset event with context tokens', async () => {
    const { ctx, session } = await makeSession('delta-merge')
    const resets: Array<{ type: string; seq: number; contextTokens: number | undefined }> = []
    const projection = new RuntimeContextProjection(ctx, session, {
      deltaThreshold: 12,
      resetSink: {
        registerResetEvent: (type, seq, contextTokens) => { resets.push({ type, seq, contextTokens }) },
      },
    })
    projection.register('Alpha state', [{ name: 'a', text: 'Alpha state' }])
    projection.register('Alpha state\n\nBeta state', [
      { name: 'a', text: 'Alpha state' },
      { name: 'b', text: 'Beta state' },
    ])

    // 2 区间、总长超阈值 → 尾部合并为单区间，并登记 tailMerge 重置事件。
    expect(projection.pendingRangeCount()).toBe(1)
    expect(projection.tailMergeCount()).toBe(1)
    expect(resets.map(reset => reset.type)).toEqual(['tailMerge'])
    expect(projection.pendingDeltaText()).toBe('Alpha state\n\nBeta state')
    // 重置事件携带上下文 token 数估计（基线文本长度 / 3，向上取整；设计 L0
    // ASCII 密集 chars/3 保守估算）。基线 = 'Alpha state\n\nBeta state'
    // (23 chars), ceil(23/3) = 8
    expect(resets[0]?.contextTokens).toBe(8)

    // 阈值内不触发合并。
    const { ctx: ctx2, session: session2 } = await makeSession('delta-merge-noop')
    const resets2: string[] = []
    const noop = new RuntimeContextProjection(ctx2, session2, {
      deltaThreshold: 1000,
      resetSink: { registerResetEvent: (type) => { resets2.push(type) } },
    })
    noop.register('Alpha state', [{ name: 'a', text: 'Alpha state' }])
    noop.register('Alpha state\n\nBeta state', [
      { name: 'a', text: 'Alpha state' },
      { name: 'b', text: 'Beta state' },
    ])
    expect(noop.pendingRangeCount()).toBe(2)
    expect(noop.tailMergeCount()).toBe(0)
    expect(resets2).toEqual([])
  })

  it('reports the estimated context tokens at reset time from the current baseline', async () => {
    const { ctx, session } = await makeSession('delta-merge-context-tokens')
    const calls: Array<{ seq: number; contextTokens: number | undefined }> = []
    const projection = new RuntimeContextProjection(ctx, session, {
      deltaThreshold: 12,
      resetSink: {
        registerResetEvent: (_type, seq, contextTokens) => { calls.push({ seq, contextTokens }) },
      },
    })
    // 基线 = 完整渲染上下文；chars/3 向上取整（设计 L0 保守估算）。
    projection.register('A'.repeat(100), [{ name: 'a', text: 'A'.repeat(100) }])
    projection.register('A'.repeat(100) + '\n\nB'.repeat(20), [
      { name: 'a', text: 'A'.repeat(100) },
      { name: 'b', text: 'B'.repeat(20) },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.contextTokens).toBe(Math.ceil(('A'.repeat(100) + '\n\nB'.repeat(20)).length / 3))
  })

  it('aggregates deltas per producer and does not duplicate unchanged state', async () => {
    const { ctx, session } = await makeSession('delta-producers')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('Alpha state', [{ name: 'a', text: 'Alpha state' }])
    projection.register('Alpha state\n\nBeta state', [
      { name: 'a', text: 'Alpha state' },
      { name: 'b', text: 'Beta state' },
    ])
    // 按 producer 聚合：SOURCE 一条 + b 一条。
    expect(projection.pendingRangeCount()).toBe(2)
    expect(projection.pendingDeltaText()).toBe('Alpha state\n\nBeta state')

    // 重复登记相同状态 → 去重，无新 delta。
    projection.register('Alpha state\n\nBeta state', [
      { name: 'a', text: 'Alpha state' },
      { name: 'b', text: 'Beta state' },
    ])
    expect(projection.pendingRangeCount()).toBe(2)
    expect(projection.pendingDeltaText()).toBe('Alpha state\n\nBeta state')
  })

  it('rebuilds the projection baseline from session events on restore and ignores other sessions', async () => {
    const { ctx, session } = await makeSession('delta-restore')
    // 旧格式快照日志：owned plugin/snapshot 消息（回放重建基线）。
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Old context' }],
      source: { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections: [{ name: 'policy', text: 'Mode: read-only.' }] },
    }), { surfaceOp: 'append' })

    const projection = new RuntimeContextProjection(ctx, session)
    // 恢复后状态未变 → 无 delta。
    projection.register('Old context', [{ name: 'policy', text: 'Mode: read-only.' }])
    expect(projection.pendingDeltaText()).toBe('')
    // 恢复后状态变化 → 按节登记 delta。
    projection.register('New context', [{ name: 'policy', text: 'Mode: danger-full-access.' }])
    expect(projection.pendingDeltaText()).toBe('Mode: danger-full-access.')

    // 其他会话的事件不影响本投影。
    const other = ctx.sessions.create(SessionId('delta-restore-other'))
    other.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'other context' }],
      source: { kind: 'plugin', plugin: SOURCE },
    }), { surfaceOp: 'append' })
    expect(projection.pendingDeltaText()).toBe('Mode: danger-full-access.')
  })

  it('restores the baseline from a folded real user message (new format) and does not replay unchanged context', async () => {
    const { ctx, session } = await makeSession('delta-restore-newformat')
    const SNAPSHOT_HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
    const C1 = `${SNAPSHOT_HEADER}\n\nMode: read-only.`
    const C2 = `${SNAPSHOT_HEADER}\n\nMode: danger-full-access.`

    // 新格式：上下文折叠进真实 user 消息并持久化（agent.ts 在 turn() 中 append）。
    const writer = new RuntimeContextProjection(ctx, session)
    writer.register(C1, [{ name: 'policy', text: 'Mode: read-only.' }])
    const folded = writer.foldInto([userMessage('hello')])
    session.append('user/message', folded[0]!, { surfaceOp: 'append' })

    // 恢复：基线从最后一条折叠后的真实 user 消息前缀提取，上下文未变时不再重发整段
    // （旧行为语义——恢复后不变不重发，回归修复）。
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register(C1, [{ name: 'policy', text: 'Mode: read-only.' }])
    expect(projection.pendingDeltaText()).toBe('')

    // 状态变化 → 按节登记 delta。
    projection.register(C2, [{ name: 'policy', text: 'Mode: danger-full-access.' }])
    expect(projection.pendingDeltaText()).toBe('Mode: danger-full-access.')
  })

  it('restores the tail folded delta as baseline and re-registers all sections once after a change (conservative, section table unrecoverable)', async () => {
    const { ctx, session } = await makeSession('delta-restore-newformat-multifold')
    const SNAPSHOT_HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
    const C1 = `${SNAPSHOT_HEADER}\n\nMode: read-only.\n\nGoal: build X`
    const C2 = `${SNAPSHOT_HEADER}\n\nMode: danger-full-access.\n\nGoal: build X`

    const writer = new RuntimeContextProjection(ctx, session)
    writer.register(C1, [{ name: 'policy', text: 'Mode: read-only.' }, { name: 'goal', text: 'Goal: build X' }])
    const first = writer.foldInto([userMessage('hello')])
    session.append('user/message', first[0]!, { surfaceOp: 'append' })
    session.append('assistant/message', { stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    writer.register(C2, [{ name: 'policy', text: 'Mode: danger-full-access.' }, { name: 'goal', text: 'Goal: build X' }])
    const second = writer.foldInto([userMessage('world')])
    session.append('user/message', second[0]!, { surfaceOp: 'append' })

    // 尾部折叠前缀 = 最近一次 delta（仅变更节），非完整上下文；节表不可恢复，
    // 恢复后变化按节全量登记（保守、只发生一次、不重复累积）。
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register(C2, [{ name: 'policy', text: 'Mode: danger-full-access.' }, { name: 'goal', text: 'Goal: build X' }])
    expect(projection.pendingDeltaText()).toBe('Mode: danger-full-access.\n\nGoal: build X')
  })

  it('treats a tail CLEARED fold as an unknown baseline and re-emits the full context', async () => {
    const { ctx, session } = await makeSession('delta-restore-newformat-cleared')
    const SNAPSHOT_HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
    const C1 = `${SNAPSHOT_HEADER}\n\nMode: read-only.`

    const writer = new RuntimeContextProjection(ctx, session)
    writer.register(C1, [{ name: 'policy', text: 'Mode: read-only.' }])
    const first = writer.foldInto([userMessage('hello')])
    session.append('user/message', first[0]!, { surfaceOp: 'append' })
    session.append('assistant/message', { stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    writer.register('', [])
    const cleared = writer.foldInto([userMessage('again')])
    expect(textOfMessage(cleared[0]!)).toBe(`${CLEARED_TEXT}\n\nagain`)
    session.append('user/message', cleared[0]!, { surfaceOp: 'append' })

    // 模型被告知上下文已清空 → 基线未知，恢复后首次登记整段上下文（必要重发）。
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register(C1, [{ name: 'policy', text: 'Mode: read-only.' }])
    expect(projection.pendingDeltaText()).toBe(C1)
  })

  it('does not treat short section text as covered by tool results and counts suppressions', async () => {
    const { ctx, session } = await makeSession('delta-covered-minlen')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('AAA', [{ name: 'mode', text: 'AAA' }])
    projection.foldInto([userMessage('first')])

    // 工具结果包含短节文本（< MIN_MATCH_TEXT_LENGTH=8）→ 不判覆盖，delta 正常登记。
    appendToolResult(session, 'c1', 'output AAA here')
    projection.register('BBB', [{ name: 'mode', text: 'BBB' }])
    expect(projection.pendingDeltaText()).toBe('BBB')
    expect(projection.coveredSuppressionCount()).toBe(0)

    // 工具结果包含长节文本（≥ 8 字符）→ 判覆盖，delta 被抑制并计数（可观测）。
    appendToolResult(session, 'c2', 'Mode: danger-full-access.')
    projection.register('CCC', [{ name: 'mode', text: 'Mode: danger-full-access.' }])
    expect(projection.pendingDeltaText()).toBe('BBB')
    expect(projection.coveredSuppressionCount()).toBe(1)
  })

  it('folds after plugin user messages when the last non-user message is an assistant or batch-end tool result', async () => {
    const { ctx, session } = await makeSession('delta-fold-pluginuser')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])

    // 工具批（assistant + toolResult）后跟 plugin 源 user 消息 → 折叠不被 plugin 阻断。
    const assistant = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 't1', arguments: '{}' }],
      source: { provider: 'mock', model: 'mock' },
    })
    session.append('assistant/message', { stream: [], turn: 1, step: 1, message: assistant }, { surfaceOp: 'append' })
    appendToolResult(session, 'c1', 'r1')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'tool context' }],
      source: { kind: 'plugin', plugin: 'test-tool' },
    }), { surfaceOp: 'append' })
    const folded = projection.foldInto([userMessage('hello')])
    expect(textOfMessage(folded[0]!)).toBe('C1\n\nhello')

    // 纯 assistant（无工具）后跟 plugin user 消息 → 同样可折叠。
    const { ctx: ctx2, session: session2 } = await makeSession('delta-fold-pluginuser-assistant')
    const assistantCtx = new RuntimeContextProjection(ctx2, session2)
    assistantCtx.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])
    session2.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    session2.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'tool context' }],
      source: { kind: 'plugin', plugin: 'test-tool' },
    }), { surfaceOp: 'append' })
    const folded2 = assistantCtx.foldInto([userMessage('hello')])
    expect(textOfMessage(folded2[0]!)).toBe('C1\n\nhello')

    // 控制组：目标与更早的工具批之间插了一条真实 user 消息（'real earlier'）。
    // canFoldAfter 只跳过 plugin 注入消息，遇到真实 user 即停并推迟（保守）——
    // 更早的批末 toolResult 确实存在，但实现不越过这条真实 user 去够它，故推迟。
    const first = projection.foldInto([userMessage('hello')]) // 消费当前 delta 不相关，仅确保状态一致
    void first
    session.append('user/message', userMessage('real earlier'), { surfaceOp: 'append' })
    projection.register('C2', [{ name: 'policy', text: 'Mode: danger-full-access.' }])
    const input = userMessage('hello2')
    const deferred = projection.foldInto([input])
    expect(deferred).toEqual([input])
    expect(deferred[0]).toBe(input)
    expect(projection.pendingDeltaText()).not.toBe('')
  })

  it('reclaims only the deltas at or before the compaction boundary and keeps post-boundary ranges', async () => {
    const { ctx, session } = await makeSession('delta-reclaim-partial')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])
    const assistantSeq = session.append('assistant/message', { stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 't1', arguments: '{}' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' }).seq
    const resultSeq = appendToolResult(session, 'c1', 'r1')
    projection.register('C2', [
      { name: 'policy', text: 'Mode: danger-full-access.' },
      { name: 'goal', text: 'Goal: build X' },
    ])

    // 压缩替换覆盖 [assistant..toolResult]（边界 end = resultSeq）：只回收边界前的 delta。
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted' }],
      source: { kind: 'plugin', plugin: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', start: assistantSeq, end: resultSeq },
      sourceEventSeqs: [assistantSeq, resultSeq],
    })
    expect(projection.pendingDeltaText()).toBe('Mode: danger-full-access.\n\nGoal: build X')
    expect(projection.reclaimedUnfoldedRanges()).toBe(1)
    expect(projection.reclaimedUnfoldedChars()).toBe('C1'.length)

    // 回收后同一 producer 继续登记 → 合并进已有区间（不丢失索引），takeDeltas 含全部。
    projection.register('C3', [
      { name: 'policy', text: 'Mode: sandbox-only.' },
      { name: 'goal', text: 'Goal: build X' },
    ])
    expect(projection.pendingDeltaText()).toBe('Mode: danger-full-access.\n\nMode: sandbox-only.\n\nGoal: build X')
  })

  it('merges tail ranges only above the threshold and not at the equality boundary', async () => {    // 总长恰好等于阈值 → 不触发合并（total <= threshold 提前返回）。
    const { ctx, session } = await makeSession('delta-merge-boundary-equal')
    const equal = new RuntimeContextProjection(ctx, session, { deltaThreshold: 9 })
    equal.register('Alpha', [{ name: 'a', text: 'Alpha' }])
    equal.register('Alpha\n\nBeta', [{ name: 'a', text: 'Alpha' }, { name: 'b', text: 'Beta' }])
    expect(equal.pendingRangeCount()).toBe(2)
    expect(equal.tailMergeCount()).toBe(0)

    // 总长超过阈值（9 > 8）→ 触发尾部合并为单区间。
    const { ctx: ctx2, session: session2 } = await makeSession('delta-merge-boundary-over')
    const over = new RuntimeContextProjection(ctx2, session2, { deltaThreshold: 8 })
    over.register('Alpha', [{ name: 'a', text: 'Alpha' }])
    over.register('Alpha\n\nBeta', [{ name: 'a', text: 'Alpha' }, { name: 'b', text: 'Beta' }])
    expect(over.pendingRangeCount()).toBe(1)
    expect(over.tailMergeCount()).toBe(1)

    // 单区间即使超阈值也不合并（deltas.length < 2 提前返回）。
    const { ctx: ctx3, session: session3 } = await makeSession('delta-merge-single')
    const single = new RuntimeContextProjection(ctx3, session3, { deltaThreshold: 1 })
    single.register('Alpha', [{ name: 'a', text: 'Alpha' }])
    expect(single.pendingRangeCount()).toBe(1)
    expect(single.tailMergeCount()).toBe(0)
  })

  it('folds into the first real user message and leaves the others untouched', async () => {
    const { ctx, session } = await makeSession('delta-fold-multiuser')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])
    const messages = projection.foldInto([userMessage('steer'), userMessage('claimed')])
    expect(messages).toHaveLength(2)
    expect(textOfMessage(messages[0]!)).toBe('C1\n\nsteer')
    expect(textOfMessage(messages[1]!)).toBe('claimed')
    expect(projection.pendingDeltaText()).toBe('')
  })

  it('keeps deltas pending when there is no message to fold into', async () => {
    const { ctx, session } = await makeSession('delta-fold-empty')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])
    const messages = projection.foldInto([])
    expect(messages).toEqual([])
    expect(projection.pendingDeltaText()).toBe('C1')
  })

  it('folds each new delta batch across successive rounds without resending the full context', async () => {
    const { ctx, session } = await makeSession('delta-multi-round')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])
    const first = projection.foldInto([userMessage('hello')])
    expect(textOfMessage(first[0]!)).toBe('C1\n\nhello')
    expect(projection.pendingDeltaText()).toBe('')

    // 第二轮：状态变化登记新 delta，折叠只带新变更节，不带完整上下文。
    session.append('assistant/message', { stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    projection.register('C2', [{ name: 'policy', text: 'Mode: danger-full-access.' }])
    const second = projection.foldInto([userMessage('world')])
    expect(textOfMessage(second[0]!)).toBe('Mode: danger-full-access.\n\nworld')
    expect(textOfMessage(second[0]!)).not.toContain('Mode: read-only.')
    expect(projection.pendingDeltaText()).toBe('')
  })

  it('applies a raised delta threshold after construction (context-window scaling)', async () => {
    const { ctx, session } = await makeSession('delta-threshold-late')
    const resets: string[] = []
    const projection = new RuntimeContextProjection(ctx, session, {
      deltaThreshold: 100,
      resetSink: { registerResetEvent: (type) => { resets.push(type) } },
    })
    projection.register('Alpha state', [{ name: 'a', text: 'Alpha state' }])
    projection.register('Alpha state\n\nBeta state', [{ name: 'a', text: 'Alpha state' }, { name: 'b', text: 'Beta state' }])
    expect(projection.pendingRangeCount()).toBe(2)
    expect(projection.tailMergeCount()).toBe(0)

    // 窗口解析后调高阈值：26 字符不再超阈值 → 保持 2 区间、不合并。
    projection.setDeltaThreshold(1000)
    projection.register('Alpha state\n\nBeta state\n\nGamma state', [
      { name: 'a', text: 'Alpha state' },
      { name: 'b', text: 'Beta state' },
      { name: 'c', text: 'Gamma state' },
    ])
    expect(projection.pendingRangeCount()).toBe(3)
    expect(projection.tailMergeCount()).toBe(0)
    expect(resets).toEqual([])

    // 调低阈值到合并线以下 → 下一次变化触发合并。
    projection.setDeltaThreshold(10)
    projection.register('Alpha state\n\nBeta state\n\nGamma state\n\nDelta state', [
      { name: 'a', text: 'Alpha state' },
      { name: 'b', text: 'Beta state' },
      { name: 'c', text: 'Gamma state' },
      { name: 'd', text: 'Delta state' },
    ])
    expect(projection.tailMergeCount()).toBe(1)
    expect(resets).toEqual(['tailMerge'])
  })

  it('defers folding after a batch-end tool result when deferFoldAfterToolResult is set (M4′ closure a)', async () => {
    const { ctx, session } = await makeSession('delta-defer-toolresult')
    const projection = new RuntimeContextProjection(ctx, session, { deferFoldAfterToolResult: true })
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])

    // 工具批：assistant(tool_use) → toolResult（批末）。
    const assistant = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 't1', arguments: '{}' }],
      source: { provider: 'mock', model: 'mock' },
    })
    session.append('assistant/message', { stream: [], turn: 1, step: 1, message: assistant }, { surfaceOp: 'append' })
    appendToolResult(session, 'c1', 'r1')

    // 折叠目标前驱是批末 toolResult → 延迟标志下推迟，delta 保持 pending（不丢）。
    const input = userMessage('hello')
    const deferred = projection.foldInto([input])
    expect(deferred[0]).toBe(input)
    expect(projection.pendingDeltaText()).toBe('C1')

    // 后续出现 assistant 中介（前驱变为 assistant）→ 放行折叠，积压 delta 不丢。
    session.append('assistant/message', { stream: [],
      turn: 1,
      step: 2,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    const folded = projection.foldInto([userMessage('world')])
    expect(textOfMessage(folded[0]!)).toBe('C1\n\nworld')
    expect(projection.pendingDeltaText()).toBe('')
  })

  it('folds after a batch-end tool result by default (deferFoldAfterToolResult unset)', async () => {
    const { ctx, session } = await makeSession('delta-nodefer-toolresult')
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])
    const assistant = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 't1', arguments: '{}' }],
      source: { provider: 'mock', model: 'mock' },
    })
    session.append('assistant/message', { stream: [], turn: 1, step: 1, message: assistant }, { surfaceOp: 'append' })
    appendToolResult(session, 'c1', 'r1')
    const folded = projection.foldInto([userMessage('hello')])
    expect(textOfMessage(folded[0]!)).toBe('C1\n\nhello')
    expect(projection.pendingDeltaText()).toBe('')
  })

  it('folds after an assistant predecessor regardless of deferFoldAfterToolResult', async () => {
    for (const defer of [false, true]) {
      const { ctx, session } = await makeSession(`delta-assistant-pred-defer-${defer}`)
      const projection = new RuntimeContextProjection(ctx, session, { deferFoldAfterToolResult: defer })
      projection.register('C1', [{ name: 'policy', text: 'Mode: read-only.' }])
      session.append('assistant/message', { stream: [],
        turn: 1,
        step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'mock', model: 'mock' } }),
      }, { surfaceOp: 'append' })
      const folded = projection.foldInto([userMessage('hello')])
      expect(textOfMessage(folded[0]!)).toBe('C1\n\nhello')
    }
  })

  // 接线契约（D1，agent.ts 侧）：上面三条 defer 用例覆盖的是 RuntimeContextProjection
  // 收到 `deferFoldAfterToolResult` 选项后的**投影层行为**。该选项由集成方 `agent.ts`
  // 在构造投影时按 provider 路由保守置入——见 `agent.ts` 的
  // `shouldDeferFoldAfterToolResult` / `OPENAI_COMPLETIONS_FAMILY_PROVIDERS`：
  //   · provider 命中 openai-completions 系名单（deepseek/groq/cerebras/openrouter/…）
  //     → `deferFoldAfterToolResult: true`（本文件上方 defer 用例即其效果）；
  //   · 名单外（含 anthropic-messages / openai-responses 系、自定义网关名、空/未知）
  //     → 缺省 false（本文件 'folds after a batch-end tool result by default' 用例即其效果）。
  // 判定只看构造期可解析的 provider 字符串（`LlmCallConfig` 不携带已解析 wire 协议，
  // pi-ai 的 `requiresAssistantAfterToolResult` 垫片状态也不向本包暴露），故为名单式
  // 保守匹配；误判方向安全（误置 true 只推迟折叠、delta 绝不丢）。
  // 端到端「provider → 推迟折叠」的接线断言见 `loop.spec.ts` 的
  // 'defers the tool-batch-end fold for openai-completions routes'（agent-loop 测试
  // 依赖完整 fork workspace，不在 standalone 镜像门内运行）。

  it('conservatively re-registers after restore when the folded user text itself contains a separator (D4)', async () => {
    const { ctx, session } = await makeSession('delta-restore-user-separator')
    const CTX = 'Mode: read-only.'
    const writer = new RuntimeContextProjection(ctx, session)
    writer.register(CTX, [{ name: 'policy', text: CTX }])
    // 用户原文本身含 \n\n：折叠文本 = `<delta>\n\nask\n\nfollow-up`。
    const folded = writer.foldInto([userMessage('ask\n\nfollow-up')])
    expect(textOfMessage(folded[0]!)).toBe(`${CTX}\n\nask\n\nfollow-up`)
    session.append('user/message', folded[0]!, { surfaceOp: 'append' })

    // 恢复：lastIndexOf 落到用户原文内部分段 → 基线被撑大（混入 'ask'）。
    // 保守方向：撑大的基线 ≠ 真实上下文 → 重登记该节（多登记一次，绝不丢变更）。
    const projection = new RuntimeContextProjection(ctx, session)
    projection.register(CTX, [{ name: 'policy', text: CTX }])
    expect(projection.pendingDeltaText()).toBe(CTX)

    // 真实变化仍被完整捕获（不丢）。
    projection.register('Mode: danger.', [{ name: 'policy', text: 'Mode: danger.' }])
    expect(projection.pendingDeltaText()).toBe(`${CTX}\n\nMode: danger.`)
  })
})
