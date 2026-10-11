import { describe, expect, it } from 'vitest'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSettlementMessage } from '../src/continuation-messages.ts'

const childId = SessionId('settled-child')
const summary = { type: 'text', text: `Background subagent ${childId} finished and will do no further work unless you send it more.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: ToolCallId('child-call'), name: 'read', arguments: '{}' }

describe('continuable settlement content', () => {
  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[]][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })
})

it('includes closing text alongside structured results and diagnostics', () => {
  expect(createSettlementMessage(childId, {
    stopReason: 'completed', output: [{ type: 'text', text: 'final answer' }],
    structured: { answer: 42 }, diagnostic: 'safe diagnostic',
  }).content).toEqual([
    summary,
    { type: 'text', text: 'Its closing message:' },
    { type: 'text', text: 'final answer' },
    { type: 'text', text: 'Structured result: {"answer":42}' },
    { type: 'text', text: 'safe diagnostic' },
  ])
})

it('truncates the closing text to the returnCap while keeping structured and diagnostic text', () => {
  // Go 上下文移植（returnCap）等价覆盖：settlement notice 是子输出回注父上下文的
  // 唯一通道，故超预算的收尾文本必须结构化截断（头/尾保留、中段替换为标记），
  // 而 structured/diagnostic 段落按官方语义原样保留。
  const long = 'head ' + 'x'.repeat(9000) + ' tail unfinished'
  const message = createSettlementMessage(childId, {
    stopReason: 'completed',
    output: [{ type: 'text', text: long }],
    structured: { answer: 42 },
    diagnostic: 'provider detail',
  }, true, 100)

  const texts = message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
  const closing = texts[2] ?? ''
  expect(closing).toContain('head ')
  expect(closing).toContain('tail unfinished')
  expect(closing).toContain('中间工作转录已截断')
  expect(closing.length).toBeLessThanOrEqual(100 * 3)
  expect(texts).toContain('Structured result: {"answer":42}')
  expect(texts).toContain('provider detail')
})
