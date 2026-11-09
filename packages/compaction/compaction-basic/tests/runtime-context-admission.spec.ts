/**
 * Real automatic compaction and AgentLoop request-admission regression.
 *
 * A″ 适配（W2/CTX-REL-20261108；先例 = 06b59845c1 的 A″ 驱动官方用例改写，禁删测试）：
 * 官方 df655fd11e 版断言「独立 runtime-context user 消息」载体（快照计数 2 + 两请求各带一条）。
 * A″/L2 单载体架构（R1 §7.2；TD-2/DL-8 登记，loop.spec.ts 退役注记）下运行时上下文折进
 * 真实 user 消息前缀，结构上不产生该 kind 的首请求载体（`working-directory/tests/admission.spec.ts:59`
 * 反向断言佐证）。本文件断言按 A″ 迁移载体，功能不变式保持并强化（df655fd11e 语义）：
 * 压缩前后两个请求的 wire 视图都必须携带必需 cwd——首请求经折叠载体（真实 user 消息），
 * 压缩后首请求经 surface 感知重发的独立快照（`RuntimeContextProjection.takeRestoreSnapshot`，
 * 载体被压缩替换面覆盖后的补偿投递）。
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import { expect, it } from 'vitest'

class CompactionAdapter extends LlmAdapter {
  readonly conversation: GenerateOptions[] = []
  readonly summaries: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 2048 } })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    const summarizing = last?.content.some(block => block.type === 'text' && block.text.includes('acting as a compaction engine')) === true
    if (summarizing) this.summaries.push(options)
    else this.conversation.push(options)
    if (!summarizing && this.conversation.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('work-call'), name: 'work', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = summarizing ? 'Earlier work completed.' : 'TASK COMPLETE'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it('retains required cwd in the first request after proactive compaction with optional context disabled', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-compaction-admission-')))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, {
      workingDirectory: true, systemPrompt: { includeHarnessIdentity: false, includeRuntimeContext: false },
    })
    await ctx.plugin(TokenMeter)
    const adapter = new CompactionAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'work', description: 'Do work.', parameters: {}, async execute() { return [{ type: 'text', text: 'work done' }] },
    }))
    await ctx.plugin(BasicCompaction, {
      auto: true, thresholdRatio: 0.5, headroomTokens: 0, retainTokens: 20, maxTokens: 32, compactionRetries: 0,
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('compaction-admission'), { provider: 'mock', model: 'mock' }, { cwd: root })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Old context evidence. '.repeat(700) + 'Do work once, then finish.' }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const summary = events.find(event => event.type === 'compaction/summary')
    // A″ 载体（原官方断言迁载体）：首请求的 cwd 由折叠前缀承载——压缩覆盖的正是
    // 这条真实 user 消息（官方原断言 = 独立 runtime-context 快照消息的 seq）。
    const carrier = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user'
      && event.data.content.some(block => block.type === 'text' && block.text.includes(JSON.stringify(root))))
    expect(summary?.data.shadowedSeqs).toContain(carrier?.seq)
    // 压缩边界重发（TD-2 修复）：恰好一条独立 runtime-context 快照，cwd 以
    // form='snapshot' 回到发送视图；常规路径（载体未被压缩）不产生该消息。
    const restored = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
    expect(restored).toHaveLength(1)
    type RestoredSnapshotData = { source: { kind: string; form: string }; content: Array<{ type: string; text: string }> }
    const restoredSnapshot = restored.find(e => (e.data as RestoredSnapshotData).source?.kind === 'runtime-context')
    expect(restoredSnapshot).toBeDefined()
    const restoredData = restoredSnapshot!.data as RestoredSnapshotData
    expect(restoredData.source.form).toBe('snapshot')
    expect(restoredData.content.some(block => block.type === 'text' && block.text.includes(JSON.stringify(root)))).toBe(true)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.conversation).toHaveLength(2)
    // 功能不变式（df655fd11e）：压缩前后两个请求的 wire 视图都带必需 cwd——
    // 首请求经折叠载体（真实 user 消息），压缩后首请求经独立快照消息。
    expect(adapter.conversation[0]?.messages.some(message => message.role === 'user' && message.source?.kind === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes(JSON.stringify(root))))).toBe(true)
    expect(adapter.conversation[1]?.messages.some(message => message.source?.kind === 'runtime-context'
      && message.content.some(block => block.type === 'text' && block.text.includes(JSON.stringify(root))))).toBe(true)
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
