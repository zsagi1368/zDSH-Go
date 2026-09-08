/** 原生委托适配器：无委托报错、有委托计时转发与映射、失败归一。 */
import { describe, expect, it } from 'vitest'
import {
  NATIVE_DELEGATE_DESCRIPTOR,
  NativeDelegateEngine,
} from '../src/engines/native-delegate.ts'
import type { SeamWebSearchRequest, SeamWebSearchResult } from '../src/kernel/types.ts'

const REQ = {
  query: 'native seam',
  hints: { topic: 'native seam', hard: [], soft: [] },
  count: 3,
  layer: 'native' as const,
  band: 'simple' as const,
}

describe('NATIVE_DELEGATE_DESCRIPTOR', () => {
  it('tier=native、kind=both', () => {
    expect(NATIVE_DELEGATE_DESCRIPTOR.id).toBe('native')
    expect(NATIVE_DELEGATE_DESCRIPTOR.tier).toBe('native')
    expect(NATIVE_DELEGATE_DESCRIPTOR.kind).toBe('both')
  })

  it('描述符运行期冻结（含嵌套 caps/cost）', () => {
    expect(Object.isFrozen(NATIVE_DELEGATE_DESCRIPTOR)).toBe(true)
    expect(Object.isFrozen(NATIVE_DELEGATE_DESCRIPTOR.caps)).toBe(true)
    expect(Object.isFrozen(NATIVE_DELEGATE_DESCRIPTOR.cost)).toBe(true)
  })
})

describe('NativeDelegateEngine', () => {
  it('无委托：unrepresentable / native provider unavailable，attempt 记错误码', async () => {
    const engine = new NativeDelegateEngine()
    expect(engine.delegateAvailable).toBe(false)
    await expect(engine.search(REQ)).rejects.toMatchObject({
      name: 'EngineError',
      code: 'unrepresentable',
      message: 'native provider unavailable',
      engineId: 'native',
    })
    expect(engine.lastAttempt?.outcome).toBe('unrepresentable')
  })

  it('有委托：SeamWebSearchRequest={query,maxResults} 转发 + sources 映射 NormalizedHit', async () => {
    const calls: {
      request: SeamWebSearchRequest
      signal: AbortSignal | undefined
    }[] = []
    const controller = new AbortController()
    const delegate = async (
      request: SeamWebSearchRequest,
      signal?: AbortSignal,
    ): Promise<SeamWebSearchResult> => {
      calls.push({ request, signal })
      return {
        truncated: false,
        sources: [
          {
            url: 'https://n.example/1',
            title: 'Native One',
            snippet: 'First source',
            publishedAt: '2025-01-01T00:00:00Z',
          },
          { url: 'https://n.example/2' },
        ],
      }
    }
    const engine = new NativeDelegateEngine(undefined, { search: delegate })
    expect(engine.delegateAvailable).toBe(true)
    const response = await engine.search({ ...REQ, signal: controller.signal })
    // 转发参数直映；caller-abort 信号原样透传（W-B-42）
    expect(calls.length).toBe(1)
    expect(calls[0]?.request).toEqual({ query: 'native seam', maxResults: 3 })
    expect(calls[0]?.signal).toBe(controller.signal)
    expect(engine.lastForwardMs).toBeGreaterThanOrEqual(0)
    // sources → NormalizedHit 映射；title 缺席回落 url；缺席字段保持缺席
    const [first, second] = response.hits
    expect(first?.url).toBe('https://n.example/1')
    expect(first?.title).toBe('Native One')
    expect(first?.snippet).toBe('First source')
    expect(first?.publishedAt).toBe('2025-01-01T00:00:00Z')
    expect(second?.title).toBe('https://n.example/2')
    expect('snippet' in (second ?? {})).toBe(false)
    expect(response.hits.every(hit => hit.provenance.engine === 'native')).toBe(true)
    // attempts 审计：ok + engineId
    expect(response.attempts[0]?.outcome).toBe('ok')
    expect(response.attempts[0]?.engineId).toBe('native')
  })

  it('委托抛错：归一为 transport 并记 attempt（不裸抛）', async () => {
    const engine = new NativeDelegateEngine(undefined, {
      search: async () => {
        throw new Error('seam exploded')
      },
    })
    await expect(engine.search(REQ)).rejects.toMatchObject({
      name: 'EngineError',
      code: 'transport',
      message: 'seam exploded',
      engineId: 'native',
    })
    expect(engine.lastAttempt?.outcome).toBe('transport')
  })
})
