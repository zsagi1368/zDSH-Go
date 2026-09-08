/** SearXNG 适配器：描述符冻结、URL 装配、JSON 载荷收窄离线回放、真管道离线回放。 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

import {
  buildSearxngUrl,
  parseSearxngJson,
  SEARXNG_DESCRIPTOR,
  SearxngEngine,
} from '../src/engines/searxng.ts'
import type { EngineSearchRequest } from '../src/kernel/types.ts'

const REQ: EngineSearchRequest = {
  query: 'searx json',
  hints: { topic: 'searx json', hard: [], soft: [] },
  count: 10,
  layer: 'selfhosted',
  band: 'simple',
}

describe('SEARXNG_DESCRIPTOR', () => {
  it('tier=selfhosted、延迟预算宽于免费池', () => {
    expect(SEARXNG_DESCRIPTOR.id).toBe('searxng')
    expect(SEARXNG_DESCRIPTOR.tier).toBe('selfhosted')
    expect(SEARXNG_DESCRIPTOR.latencyBudgetMs).toBeGreaterThanOrEqual(6000)
    expect(SEARXNG_DESCRIPTOR.cost.keysRequired).toBe(0)
  })

  it('描述符运行期冻结（含嵌套 caps/cost）', () => {
    expect(Object.isFrozen(SEARXNG_DESCRIPTOR)).toBe(true)
    expect(Object.isFrozen(SEARXNG_DESCRIPTOR.caps)).toBe(true)
    expect(Object.isFrozen(SEARXNG_DESCRIPTOR.cost)).toBe(true)
  })
})

describe('buildSearxngUrl', () => {
  it('format=json；locale→language；freshness→time_range 直映', () => {
    expect(
      buildSearxngUrl('https://searx.example.org', 'q term', {
        language: 'zh-CN',
        timeRange: 'week',
      }),
    ).toBe(
      'https://searx.example.org/search?q=q%20term&format=json&language=zh-CN&time_range=week',
    )
  })

  it('baseUrl 尾部斜杠归一；auto/缺席参数不拼', () => {
    expect(buildSearxngUrl('https://searx.example.org///', 'q')).toBe(
      'https://searx.example.org/search?q=q&format=json',
    )
    expect(buildSearxngUrl('https://searx.example.org', 'q', { language: 'auto' })).toBe(
      'https://searx.example.org/search?q=q&format=json',
    )
  })

  it('constructor 接收并保存 baseUrl（selfhosted 显式配置）', () => {
    const engine = new SearxngEngine(SEARXNG_DESCRIPTOR, 'https://searx.example.org')
    expect(engine.baseUrl).toBe('https://searx.example.org')
  })
})

describe('parseSearxngJson 离线回放', () => {
  const PAYLOAD = {
    query: 'x',
    results: [
      {
        url: 'https://a.example/1',
        title: 'Alpha',
        content: 'Body text',
        publishedDate: '2025-01-02T03:04:05',
      },
      { url: '', title: 'Empty url skipped' },
      { url: 'https://b.example/2' },
      { title: 'No url skipped' },
      'garbage-entry',
      null,
      {
        url: 'https://c.example/3',
        title: 'Gamma',
        content: '',
        publishedDate: 'yesterday',
      },
      {
        url: 'https://d.example/4',
        title: 'Delta',
        publishedDate: '2025-06-30',
      },
    ],
  }

  it('url/title 非空才收录；content→snippet；publishedDate 仅 ISO 形态直用', () => {
    const hits = parseSearxngJson(PAYLOAD, 10)
    expect(hits.length).toBe(3) // 空 url / 缺 title / 非 record 条目全部跳过
    expect(hits[0]?.url).toBe('https://a.example/1')
    expect(hits[0]?.title).toBe('Alpha')
    expect(hits[0]?.snippet).toBe('Body text')
    expect(hits[0]?.publishedAt).toBe('2025-01-02T03:04:05') // ISO 形态原样保留
    // content 空串与非 ISO 时间 → 字段保持缺席
    expect('snippet' in (hits[1] ?? {})).toBe(false)
    expect('publishedAt' in (hits[1] ?? {})).toBe(false)
    expect(hits[1]?.url).toBe('https://c.example/3')
    // 日历日期形态也算 ISO，直接采用
    expect(hits[2]?.publishedAt).toBe('2025-06-30')
    expect(hits[2]?.title).toBe('Delta')
  })

  it('count 截断；根非记录/results 缺席一律零结果（不是错误）', () => {
    expect(parseSearxngJson(PAYLOAD, 2).length).toBe(2)
    expect(parseSearxngJson(PAYLOAD, 0)).toEqual([])
    expect(parseSearxngJson({ results: 'not-an-array' }, 5)).toEqual([])
    expect(parseSearxngJson({}, 5)).toEqual([])
    expect(parseSearxngJson('plain string root', 5)).toEqual([])
    expect(parseSearxngJson(['array', 'root'], 5)).toEqual([])
  })

  it('安全管道已接线：stub fetch 走真管道离线回放（G1–G4 全过 → hits）', async () => {
    const payload = JSON.stringify({
      query: 'q',
      results: [{ url: 'https://a.example/1', title: 'Piped' }],
    })
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response(payload, { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await new SearxngEngine(
        SEARXNG_DESCRIPTOR,
        'https://searx.example.org',
      ).search(REQ)
      expect(response.hits.length).toBe(1)
      expect(response.hits[0]?.title).toBe('Piped')
      expect(response.attempts[0]?.outcome).toBe('ok')
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
