import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { RuntimeContextProjection } from '../src/runtime-context.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test-compaction': { kind: 'test-compaction' } & ContextFormed
  }
}

const SOURCE = 'runtime-context'

function contextMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE },
  })
}

describe('RuntimeContextProjection (legacy restore & session isolation)', () => {
  it('restores the latest visible owned snapshot baseline and ignores other sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('runtime-context-replay'))
    // 'retained' 事件仅用于构造可见快照基线，其 seq 本身不参与后续断言。
    session.append('user/message', contextMessage('retained'), { surfaceOp: 'append' })
    const shadowed = session.append('user/message', contextMessage('shadowed'), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', startSeq: shadowed.seq, endSeq: shadowed.seq },
      sourceEventSeqs: [shadowed.seq],
    })

    const projection = new RuntimeContextProjection(ctx, session)
    // L2 口径（A″ 载体）：恢复后状态未变 → 无 delta（不产生完整快照消息）。
    projection.register('retained', [{ name: 'policy', text: 'retained' }])
    expect(projection.pendingDeltaText()).toBe('')

    // 其他会话不影响本投影。
    const other = ctx.sessions.create(SessionId('runtime-context-other'))
    other.append('user/message', contextMessage('other'), { surfaceOp: 'append' })
    expect(projection.pendingDeltaText()).toBe('')
  })
})
