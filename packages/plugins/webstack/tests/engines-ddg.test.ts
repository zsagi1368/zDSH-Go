/** DDG 适配器：描述符冻结、URL/头装配、HTML 解析器离线回放、真管道离线回放。 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

import {
  buildDdgUrl,
  DDG_DESCRIPTOR,
  DdgEngine,
  ddgAcceptLanguage,
  parseDdgHtml,
} from '../src/engines/ddg.ts'
import type { EngineSearchRequest } from '../src/kernel/types.ts'

const REQ: EngineSearchRequest = {
  query: 'webstack contract',
  hints: { topic: 'webstack contract', hard: [], soft: [] },
  count: 10,
  layer: 'free',
  band: 'simple',
}

describe('DDG_DESCRIPTOR', () => {
  it('tier=free、cost.keysRequired=0、kind=search', () => {
    expect(DDG_DESCRIPTOR.id).toBe('ddg')
    expect(DDG_DESCRIPTOR.tier).toBe('free')
    expect(DDG_DESCRIPTOR.kind).toBe('search')
    expect(DDG_DESCRIPTOR.cost.keysRequired).toBe(0)
    expect(DDG_DESCRIPTOR.latencyBudgetMs).toBeGreaterThan(0)
  })

  it('描述符运行期冻结（含嵌套 caps/cost）', () => {
    expect(Object.isFrozen(DDG_DESCRIPTOR)).toBe(true)
    expect(Object.isFrozen(DDG_DESCRIPTOR.caps)).toBe(true)
    expect(Object.isFrozen(DDG_DESCRIPTOR.cost)).toBe(true)
  })
})

describe('请求装配', () => {
  it('URL：query 编码；siteFilter 以 ` site:` 硬约束追加（W-B-15）', () => {
    expect(buildDdgUrl('hello world')).toBe('https://html.duckduckgo.com/html/?q=hello%20world')
    expect(buildDdgUrl('hello', 'example.org')).toBe(
      'https://html.duckduckgo.com/html/?q=hello%20site%3Aexample.org',
    )
  })

  it('Accept-Language 映射：zh→zh-CN、en→en-US、auto/缺席不带', () => {
    expect(ddgAcceptLanguage('zh-CN')).toBe('zh-CN')
    expect(ddgAcceptLanguage('en')).toBe('en-US')
    expect(ddgAcceptLanguage('auto')).toBeUndefined()
    expect(ddgAcceptLanguage(undefined)).toBeUndefined()
    expect(ddgAcceptLanguage('fr')).toBe('fr')
  })
})

describe('parseDdgHtml 离线回放', () => {
  // 合成 fixture：跳转链接 uddg 还原 + 实体标题 + snippet 块 + 两类坏行。
  const FIXTURE = [
    '<div class="result results_links">',
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fq%3D1%26lang%3Dzh&amp;rut=abc">Example <b>Site</b> &amp; More</a>',
    '<a class="result__snippet" href="//duckduckgo.com/l/">A &quot;snippet&quot; with &#x27;quotes&#x27; &amp; <span>tags</span></a>',
    '</div>',
    '<div><a class="result__a" href="https://direct.example.org/no-redirect">Direct Link (no uddg)</a></div>',
    '<div><a class="result__a" href="//duckduckgo.com/l/?uddg=%ZZbroken&amp;rut=x">Broken Encoding</a></div>',
    '<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnotitle.example%2F"><img src="x.png" alt=""></a></div>',
    '<div>',
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthird.example.net%2Fx">Third</a>',
    '</div>',
  ].join('\n')

  it('uddg 还原原始 URL 且保留首见原样（W-B-35），实体解码，坏行跳过', () => {
    const hits = parseDdgHtml(FIXTURE, 10)
    expect(hits.length).toBe(3) // 直链无 uddg 与 %ZZ 坏行被跳过
    expect(hits[0]?.url).toBe('https://example.com/a?q=1&lang=zh')
    expect(hits[0]?.title).toBe('Example Site & More')
    expect(hits[0]?.snippet).toBe('A "snippet" with \'quotes\' & tags')
    // 标题剥离后为空 → 回落 url（不编造占位文本）
    expect(hits[1]?.url).toBe('https://notitle.example/')
    expect(hits[1]?.title).toBe('https://notitle.example/')
    expect(hits[2]?.url).toBe('https://third.example.net/x')
    // 无 snippet 块 → 字段保持缺席
    expect('snippet' in (hits[2] ?? {})).toBe(false)
  })

  it('count 截断与零结果语义（零结果不是错误）', () => {
    expect(parseDdgHtml(FIXTURE, 2).length).toBe(2)
    expect(parseDdgHtml(FIXTURE, 0)).toEqual([])
    expect(parseDdgHtml('<html><body>no anchors here</body></html>', 5)).toEqual([])
  })

  it('安全管道已接线：stub fetch 走真管道离线回放（G1–G4 全过 → hits）', async () => {
    const html = [
      '<div class="result">',
      '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Piped</a>',
      '</div>',
    ].join('\n')
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response(html, { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await new DdgEngine().search(REQ)
      expect(response.hits.length).toBe(1)
      expect(response.hits[0]?.url).toBe('https://example.com/a')
      expect(response.attempts[0]?.outcome).toBe('ok')
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
