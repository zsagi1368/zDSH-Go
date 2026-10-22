// @vitest-environment jsdom
/**
 * The runtime-context prefix on a user message: the harness folds its per-turn
 * operational facts into the head of the next real user message, and the
 * transcript must not show that bookkeeping as if the person had typed it.
 */
import { describe, expect, it } from 'vitest'
import {
  stripRuntimeContextBlocks,
  stripRuntimeContextPrefix,
} from '../src/client/conversation-nodes/runtime-context-prefix.ts'

const HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

describe('runtime-context prefix', () => {
  it('removes the snapshot the harness folded ahead of the words', () => {
    const text = `${HEADER}\n\nCurrent working directory: "/repo".\n\n你好`
    expect(stripRuntimeContextPrefix(text)).toBe('你好')
  })

  it('removes the cleared marker too', () => {
    const text = `${CLEARED}\n\n你好`
    expect(stripRuntimeContextPrefix(text)).toBe('你好')
  })

  it('leaves a message that carries no prefix untouched', () => {
    expect(stripRuntimeContextPrefix('你好')).toBe('你好')
    expect(stripRuntimeContextPrefix('第一段\n\n第二段')).toBe('第一段\n\n第二段')
  })

  it('leaves a message that merely mentions the header untouched', () => {
    // The strip is anchored on the header AT THE HEAD, not on a "last blank
    // line" rule: the person's own text may contain blank lines, and a rule
    // that guessed at the boundary would cut the wrong one out.
    const text = '为什么会有 Current runtime context. This snapshot supersedes earlier runtime-context snapshots. 这一段？\n\n后面还有'
    expect(stripRuntimeContextPrefix(text)).toBe(text)
  })

  it('strips the first text block and leaves the rest of the message alone', () => {
    const content = [
      { type: 'text' as const, text: `${HEADER}\n\nCurrent working directory: "/repo".\n\n你好` },
      { type: 'text' as const, text: '第二块' },
    ]
    expect(stripRuntimeContextBlocks(content)).toEqual([
      { type: 'text', text: '你好' },
      { type: 'text', text: '第二块' },
    ])
  })

  it('leaves a message whose first block is not text alone', () => {
    const content = [{ type: 'image' as const, path: 'x.png' }]
    expect(stripRuntimeContextBlocks(content)).toBe(content)
  })
})
