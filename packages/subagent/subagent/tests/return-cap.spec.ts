import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  computeSubagentReturnCap,
  estimateApproxTokens,
  MIN_SUBAGENT_RETURN_CAP,
  truncateSubagentOutput,
} from '../src/return-cap.ts'

function text(blocks: ContentBlock[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

describe('estimateApproxTokens', () => {
  it('counts empty text as zero tokens', () => {
    expect(estimateApproxTokens('')).toBe(0)
  })

  it('uses the chars/3 approximation (L0 rule)', () => {
    // 300 ASCII chars → 100 tokens.
    expect(estimateApproxTokens('a'.repeat(300))).toBe(100)
    // 301 chars → ceil(301/3) = 101 tokens.
    expect(estimateApproxTokens('a'.repeat(301))).toBe(101)
  })
})

describe('computeSubagentReturnCap', () => {
  it('matches the locked §1.3 budget-table values', () => {
    // Locked rows from CONTEXT-CACHE-MANAGEMENT.md §1.3 / model-slots BUDGET_TABLE:
    //   32k  (maxTokens 3276)  → 2048
    //   200k (maxTokens 20480) → 2304
    //   1M cap128k (maxTokens 104857) → 7577
    expect(computeSubagentReturnCap(3276)).toBe(2048)
    expect(computeSubagentReturnCap(20480)).toBe(2304)
    expect(computeSubagentReturnCap(104857)).toBe(7577)
  })

  it('never returns below the 2048 floor', () => {
    // Any positive maxTokens yields the floor when the formula does.
    expect(computeSubagentReturnCap(1024)).toBe(2048)
    expect(computeSubagentReturnCap(1)).toBe(2048)
    expect(computeSubagentReturnCap(3276)).toBe(MIN_SUBAGENT_RETURN_CAP)
  })

  it('rejects non-finite or non-positive maxTokens', () => {
    expect(() => computeSubagentReturnCap(0)).toThrow(RangeError)
    expect(() => computeSubagentReturnCap(-5)).toThrow(RangeError)
    expect(() => computeSubagentReturnCap(Number.NaN)).toThrow(RangeError)
    expect(() => computeSubagentReturnCap(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('truncateSubagentOutput', () => {
  it('returns the original blocks unchanged when under budget', () => {
    const output = [textBlock('short answer')]
    const result = truncateSubagentOutput(output, MIN_SUBAGENT_RETURN_CAP)
    expect(result).toBe(output) // identity: no copy when nothing is cut
  })

  it('returns the original blocks unchanged at exactly the budget', () => {
    // 2048 tokens = 6144 chars exactly → under/at budget → unchanged.
    const output = [textBlock('x'.repeat(6144))]
    expect(truncateSubagentOutput(output, 2048)).toBe(output)
  })

  it('truncates over-budget output keeping head and tail with a marker', () => {
    const body = 'b'.repeat(3000)
    const tail = 'c'.repeat(3000)
    const output = [textBlock(`conclusion ${body} work ${tail} unfinished`)]
    // Budget 1000 tokens = 3000 chars; the marker costs its own chars.
    const result = truncateSubagentOutput(output, 1000)
    expect(result).toHaveLength(1)
    const truncated = text(result)
    expect(truncated).toContain('conclusion')
    expect(truncated).toContain('unfinished')
    expect(truncated).toContain('中间工作转录已截断')
    // The result fits within the budget (marker included).
    expect(estimateApproxTokens(truncated)).toBeLessThanOrEqual(1000)
    // The middle body was dropped.
    expect(truncated).not.toContain(body)
  })

  it('preserves the tail (changed files / unfinished items) over the middle', () => {
    const output = [
      textBlock('结论: done.'),
      textBlock('中间过程 ' + 'w'.repeat(5000)),
      textBlock('改动文件: src/a.ts'),
      textBlock('未尽事项: none'),
    ]
    const result = truncateSubagentOutput(output, 500)
    const truncated = text(result)
    expect(truncated).toContain('结论: done.')
    expect(truncated).toContain('改动文件: src/a.ts')
    expect(truncated).toContain('未尽事项: none')
    expect(estimateApproxTokens(truncated)).toBeLessThanOrEqual(500)
  })

  it('drops non-text blocks only when truncation happens', () => {
    const blocks: ContentBlock[] = [
      textBlock('a'.repeat(9000)),
      { type: 'reasoning', text: 'hidden' },
    ]
    // Under budget: non-text blocks are preserved.
    expect(truncateSubagentOutput(blocks, 5000)).toBe(blocks)
    // Over budget: only text survives in the truncated single block.
    const result = truncateSubagentOutput(blocks, 100)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('text')
  })

  it('honors an explicitly configured sub-floor cap (no silent clamp)', () => {
    const output = [textBlock('a'.repeat(10000))]
    const result = truncateSubagentOutput(output, 10)
    expect(estimateApproxTokens(text(result))).toBeLessThanOrEqual(10)
  })

  it('returns a marker-less head-only slice when the budget cannot hold the marker', () => {
    const output = [textBlock('a'.repeat(1000))]
    const result = truncateSubagentOutput(output, 5)
    // Budget 5 tokens = 15 chars, less than the marker length → head only.
    expect(text(result)).toHaveLength(15)
    expect(text(result)).not.toContain('中间工作转录已截断')
  })

  it('handles empty output', () => {
    expect(truncateSubagentOutput([], 2048)).toEqual([])
  })
})
