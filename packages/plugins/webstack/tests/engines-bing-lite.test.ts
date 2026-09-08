/** Bing lite 适配器：描述符冻结、RSS URL 装配、解析器离线回放、真管道离线回放。 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

import {
  BING_LITE_DESCRIPTOR,
  BingLiteEngine,
  buildBingLiteUrl,
  parseBingRss,
} from '../src/engines/bing-lite.ts'
import type { EngineSearchRequest } from '../src/kernel/types.ts'

const REQ: EngineSearchRequest = {
  query: 'webstack rss',
  hints: { topic: 'webstack rss', hard: [], soft: [] },
  count: 10,
  layer: 'free',
  band: 'simple',
}

describe('BING_LITE_DESCRIPTOR', () => {
  it('tier=free、caps.news=true、keysRequired=0', () => {
    expect(BING_LITE_DESCRIPTOR.id).toBe('bing-lite')
    expect(BING_LITE_DESCRIPTOR.tier).toBe('free')
    expect(BING_LITE_DESCRIPTOR.caps.news).toBe(true)
    expect(BING_LITE_DESCRIPTOR.cost.keysRequired).toBe(0)
  })

  it('描述符运行期冻结（含嵌套 caps/cost）', () => {
    expect(Object.isFrozen(BING_LITE_DESCRIPTOR)).toBe(true)
    expect(Object.isFrozen(BING_LITE_DESCRIPTOR.caps)).toBe(true)
    expect(Object.isFrozen(BING_LITE_DESCRIPTOR.cost)).toBe(true)
  })
})

describe('buildBingLiteUrl', () => {
  it('q 编码 + format=rss + count 直映', () => {
    expect(buildBingLiteUrl('hello world', 7)).toBe(
      'https://www.bing.com/search?q=hello%20world&format=rss&count=7',
    )
  })

  it('siteFilter 以预编码 +site%3A 拼进 q 参数', () => {
    expect(buildBingLiteUrl('hi', 10, 'example.org')).toBe(
      'https://www.bing.com/search?q=hi+site%3Aexample.org&format=rss&count=10',
    )
  })
})

describe('parseBingRss 离线回放', () => {
  const RSS = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    '<item>',
    '<title>Fresh &amp; First</title>',
    '<link>https://one.example.org/a?x=1&amp;y=2</link>',
    '<pubDate>Tue, 12 Aug 2025 08:00:00 GMT</pubDate>',
    '<description><![CDATA[Desc <b>one</b> &quot;quoted&quot;]]></description>',
    '</item>',
    '<item><link>https://two.example.org/b</link><pubDate>not-a-date</pubDate><description>No title here</description></item>',
    '<item><title>No link item</title><description>should be skipped</description></item>',
    '<item><title><![CDATA[Third CDATA]]></title><link>https://three.example.org/c</link></item>',
    '</channel></rss>',
  ].join('\n')

  it('实体/CDATA 解码、pubDate→ISO、坏行（无 link）跳过', () => {
    const hits = parseBingRss(RSS, 10)
    expect(hits.length).toBe(3)
    expect(hits[0]?.url).toBe('https://one.example.org/a?x=1&y=2')
    expect(hits[0]?.title).toBe('Fresh & First')
    expect(hits[0]?.publishedAt).toBe('2025-08-12T08:00:00.000Z')
    expect(hits[0]?.snippet).toBe('Desc one "quoted"')
    // 无 title → 回落 url；pubDate 解析失败 → publishedAt 缺席
    expect(hits[1]?.title).toBe('https://two.example.org/b')
    expect('publishedAt' in (hits[1] ?? {})).toBe(false)
    expect(hits[1]?.snippet).toBe('No title here')
    // CDATA 标题直取；无 description → snippet 缺席
    expect(hits[2]?.title).toBe('Third CDATA')
    expect(hits[2]?.url).toBe('https://three.example.org/c')
    expect('snippet' in (hits[2] ?? {})).toBe(false)
  })

  it('count 截断与零条目语义（空 feed 不是错误）', () => {
    expect(parseBingRss(RSS, 2).length).toBe(2)
    expect(parseBingRss(RSS, 0)).toEqual([])
    expect(
      parseBingRss('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>', 5),
    ).toEqual([])
  })

  it('安全管道已接线：stub fetch 走真管道离线回放（G1–G4 全过 → hits）', async () => {
    const rss = [
      '<?xml version="1.0"?><rss version="2.0"><channel>',
      '<item><title>Piped</title><link>https://one.example.org/a</link></item>',
      '</channel></rss>',
    ].join('\n')
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response(rss, { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await new BingLiteEngine().search(REQ)
      expect(response.hits.length).toBe(1)
      expect(response.hits[0]?.title).toBe('Piped')
      expect(response.attempts[0]?.outcome).toBe('ok')
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
