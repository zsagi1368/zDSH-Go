/**
 * X 垂直频道离线测试（全离线，不出网）：
 * - 描述符契约与深冻结；canHandle 判定矩阵；
 * - /status/<id> 形态正则抽取；oEmbed 富化（注入假 outboundFetch）；
 * - 两腿失败静默返回空数组不抛错；via 如实标注（W-B-17）；
 * - 单飞防重、每 URL 一次会话内缓存、保序去重、count 截断；
 * - VerticalRegistry register/list/canRun 治理面。
 */
import { describe, expect, it, vi } from 'vitest'
import { type NormalizedHit, type VerticalDeps, VerticalRegistry } from '../src/framework.ts'
import {
  buildOembedUrl,
  buildXSearchQuery,
  extractTweetUrls,
  isTweetUrl,
  OEMBED_ENDPOINT,
  VIA_OEMBED,
  VIA_SITE_SEARCH,
  X_OEMBED_NOTE_KEY,
  X_VERTICAL_DESCRIPTOR,
  X_VERTICAL_ID,
  XVerticalChannel,
} from '../src/x-search.ts'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const HINTS = { hard: [], soft: [] } as const

function tweetHit(url = 'https://x.com/alice/status/1234567890123456789'): NormalizedHit {
  return { url, title: url, snippet: '腿1原始摘要', provenance: { engine: 'ddg' } }
}

function makeReq(topic: string, count = 5) {
  return { query: topic, hints: { ...HINTS, topic }, count }
}

/** 假 oEmbed 出站：记录请求 URL，返回官方 JSON 形态的 html 字段。 */
function fakeOutbound(html?: string, status = 200) {
  const body = html === undefined ? '{}' : JSON.stringify({ html, author_name: 'alice' })
  return vi.fn(async (req: { url: string }) => ({ status, text: async () => body, url: req.url }))
}

describe('描述符契约', () => {
  it('id/tier/caps/cost 全对齐且深冻结（防运行期篡改名片）', () => {
    expect(X_VERTICAL_DESCRIPTOR).toMatchObject({
      id: 'x-vertical',
      kind: 'search',
      tier: 'free',
      caps: { vertical: true },
      cost: { keysRequired: 0 },
    })
    expect(Object.isFrozen(X_VERTICAL_DESCRIPTOR)).toBe(true)
    expect(Object.isFrozen(X_VERTICAL_DESCRIPTOR.caps)).toBe(true)
  })
})

describe('canHandle 判定矩阵', () => {
  const channel = new XVerticalChannel()

  it('siteFilter 落在 x/twitter 及子域 → true；大小写/尾点容忍', () => {
    expect(channel.canHandle({ ...HINTS, siteFilter: 'x.com' })).toBe(true)
    expect(channel.canHandle({ ...HINTS, siteFilter: 'twitter.com' })).toBe(true)
    expect(channel.canHandle({ ...HINTS, siteFilter: 'mobile.twitter.com' })).toBe(true)
    expect(channel.canHandle({ ...HINTS, siteFilter: 'X.COM.' })).toBe(true)
  })

  it('hard/soft 片段含显式站点指称 → true；其余一律 false', () => {
    expect(channel.canHandle({ ...HINTS, soft: ['site:x.com 最新消息'] })).toBe(true)
    expect(channel.canHandle({ ...HINTS, hard: ['twitter.com 上看看'] })).toBe(true)
    expect(channel.canHandle(HINTS)).toBe(false)
    expect(channel.canHandle({ ...HINTS, siteFilter: 'example.com' })).toBe(false)
    expect(channel.canHandle({ ...HINTS, soft: ['x.commerce 议题'] })).toBe(false)
  })
})

describe('/status/<id> 正则抽取', () => {
  it('x/twitter 双域 + www/mobile/裸域命中；status 与 statuses 等价；保序去重', () => {
    expect(isTweetUrl('https://x.com/alice/status/1234567890123456789')).toBe(true)
    expect(isTweetUrl('http://www.twitter.com/bob/statuses/42')).toBe(true)
    expect(isTweetUrl('https://mobile.x.com/carol/status/7?q=1')).toBe(true)
    // W-B-35：url 保留首见原样，不做规范化改写——带查询串的变体按原样保留，
    // 仅对完全相同的字符串去重。
    expect(
      extractTweetUrls([
        'https://x.com/a1/status/111',
        'https://x.com/a1/status/222',
        'https://x.com/a1/status/111',
        'not-a-tweet',
      ]),
    ).toEqual(['https://x.com/a1/status/111', 'https://x.com/a1/status/222'])
  })

  it('非 status 路径 / 非目标域 / 非数字 id / 相对链接 一律拒绝', () => {
    for (const bad of [
      'https://x.com/alice/profile',
      'https://example.com/alice/status/123',
      'https://x.com/alice/status/abc123',
      '//x.com/alice/status/123',
      'ftp://x.com/alice/status/123',
      '',
    ]) {
      expect(isTweetUrl(bad)).toBe(false)
    }
  })
})

describe('查询构造与 oEmbed URL 构造', () => {
  it('buildXSearchQuery：双站 OR 限域 + 主题词', () => {
    expect(buildXSearchQuery('webstack 发布')).toBe('site:x.com OR site:twitter.com webstack 发布')
  })

  it('buildOembedUrl：url 参数整体编码 + omit_script/dnt 固定开启', () => {
    expect(buildOembedUrl('https://x.com/a/status/1')).toBe(
      `${OEMBED_ENDPOINT}?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1&omit_script=true&dnt=true`,
    )
  })
})

describe('两腿链路与 via 标注', () => {
  it('腿2 富化成功 → snippet 替换为 oEmbed 纯文本、via=oembed、note=i18n 键', async () => {
    const channel = new XVerticalChannel()
    const outbound = fakeOutbound(
      '<blockquote class="twitter-tweet"><p>富化后的推文正文 &amp; 更多</p></blockquote>',
    )
    const deps: VerticalDeps = {
      search: vi.fn(async () => [tweetHit()]),
      outboundFetch: outbound,
    }
    const hits = await channel.run(makeReq('主题'), deps)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.snippet).toBe('富化后的推文正文 & 更多')
    expect(hits[0]?.provenance.via).toBe(VIA_OEMBED)
    expect(hits[0]?.provenance.note).toBe(X_OEMBED_NOTE_KEY)
    expect(hits[0]?.provenance.engine).toBe('ddg')
    expect(outbound.mock.calls[0]?.[0]?.url.startsWith(OEMBED_ENDPOINT)).toBe(true)
  })

  // ---- W10 审计回归：oEmbed html 富化的 script/style 内容体剥离 ------------
  it('W10 安全：oEmbed html 内 <script> 整块剥离，JS 源码不进 snippet', async () => {
    const channel = new XVerticalChannel()
    const outbound = fakeOutbound(
      '<blockquote class="twitter-tweet"><p>推文正文内容</p></blockquote><script async src="https://platform.example/widgets.js">alert(1)</script>',
    )
    const deps: VerticalDeps = {
      search: vi.fn(async () => [tweetHit()]),
      outboundFetch: outbound,
    }
    const hits = await channel.run(makeReq('主题'), deps)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.provenance.via).toBe(VIA_OEMBED)
    expect(hits[0]?.snippet).not.toContain('alert(1)')
    expect(hits[0]?.snippet).toContain('推文正文内容')
  })

  it('W10 安全：实体混淆形态 &lt;script&gt; 解码后二次扫描同样剥除', async () => {
    const channel = new XVerticalChannel()
    const outbound = fakeOutbound('<p>正文段落</p>&lt;script&gt;evilPayload()&lt;/script&gt;')
    const deps: VerticalDeps = {
      search: vi.fn(async () => [tweetHit()]),
      outboundFetch: outbound,
    }
    const hits = await channel.run(makeReq('主题'), deps)
    expect(hits[0]?.snippet).not.toContain('evilPayload')
    expect(hits[0]?.snippet).toContain('正文段落')
  })

  it('W10 安全：<style> 块内容体一并剥离', async () => {
    const channel = new XVerticalChannel()
    const outbound = fakeOutbound('<style>.a{color:red}</style><p>样式后的正文</p>')
    const deps: VerticalDeps = {
      search: vi.fn(async () => [tweetHit()]),
      outboundFetch: outbound,
    }
    const hits = await channel.run(makeReq('主题'), deps)
    expect(hits[0]?.snippet).not.toContain('color:red')
    expect(hits[0]?.snippet).toContain('样式后的正文')
  })

  it('非推文结果直通：via=site-search 且绝不触发出站', async () => {
    const channel = new XVerticalChannel()
    const outbound = fakeOutbound('<p>不该被调用</p>')
    const deps: VerticalDeps = {
      search: vi.fn(async () => [
        { url: 'https://blog.example/post', title: '博客', provenance: { engine: 'bing-lite' } },
      ]),
      outboundFetch: outbound,
    }
    const hits = await channel.run(makeReq('主题'), deps)
    expect(hits[0]?.provenance.via).toBe(VIA_SITE_SEARCH)
    expect(outbound).not.toHaveBeenCalled()
  })

  it('oEmbed 非 2xx / 坏 JSON / 出站抛错 → 如实保留腿1摘要并标注 site-search', async () => {
    const channel = new XVerticalChannel()
    for (const outbound of [
      fakeOutbound(undefined, 404),
      fakeOutbound('not-json'),
      vi.fn(async () => {
        throw new Error('transport down')
      }),
    ]) {
      const deps: VerticalDeps = {
        search: vi.fn(async () => [tweetHit()]),
        outboundFetch: outbound,
      }
      const hits = await channel.run(makeReq('主题'), deps)
      expect(hits[0]?.snippet).toBe('腿1原始摘要')
      expect(hits[0]?.provenance.via).toBe(VIA_SITE_SEARCH)
    }
  })

  it('腿1 抛错（两腿全失败）→ 返回空数组不抛错，出站零调用', async () => {
    const channel = new XVerticalChannel()
    const outbound = fakeOutbound('<p>x</p>')
    const deps: VerticalDeps = {
      search: vi.fn(async () => {
        throw new Error('free pool down')
      }),
      outboundFetch: outbound,
    }
    await expect(channel.run(makeReq('主题'), deps)).resolves.toEqual([])
    expect(outbound).not.toHaveBeenCalled()
  })

  it('outboundFetch 缺席（未接线）→ 腿2 静默跳过，腿1 结果照常带标注上呈', async () => {
    const channel = new XVerticalChannel()
    const deps: VerticalDeps = { search: vi.fn(async () => [tweetHit()]) }
    const hits = await channel.run(makeReq('主题'), deps)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.provenance.via).toBe(VIA_SITE_SEARCH)
  })

  it('engine 缺失时兜底盖本频道 id（W-B-16 出处可解释性）', async () => {
    const channel = new XVerticalChannel()
    const deps: VerticalDeps = {
      search: vi.fn(async () => [
        { url: 'https://x.com/a/status/1', title: 't', provenance: { engine: '' } },
      ]),
    }
    const hits = await channel.run(makeReq('主题'), deps)
    expect(hits[0]?.provenance.engine).toBe(X_VERTICAL_ID)
  })
})

describe('并发治理与成本纪律', () => {
  it('单飞防重：同主题并发 run 共享一次执行（search 仅一次）', async () => {
    const channel = new XVerticalChannel()
    const search = vi.fn(async () => [tweetHit()])
    const deps: VerticalDeps = { search }
    const [a, b] = await Promise.all([
      channel.run(makeReq('同主题'), deps),
      channel.run(makeReq('同主题'), deps),
    ])
    expect(search).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    // 结算后锁已释放：新一轮调用重新执行。
    await channel.run(makeReq('同主题'), deps)
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('每 URL 一次会话内缓存：重复 run 不重复出站，缓存仍可富化', async () => {
    const channel = new XVerticalChannel()
    const outbound = fakeOutbound('<p>缓存的富化文本</p>')
    const deps: VerticalDeps = { search: vi.fn(async () => [tweetHit()]), outboundFetch: outbound }
    const first = await channel.run(makeReq('t'), deps)
    const second = await channel.run(makeReq('t'), deps)
    expect(outbound).toHaveBeenCalledTimes(1)
    expect(second[0]?.snippet).toBe('缓存的富化文本')
    expect(second[0]?.provenance.via).toBe(VIA_OEMBED)
    void first
  })

  it('保序去重 + count 截断：重复 URL 只留首见，产出 ≤ req.count', async () => {
    const channel = new XVerticalChannel()
    const search = vi.fn(async () => [
      tweetHit('https://x.com/a/status/1'),
      tweetHit('https://x.com/a/status/1'),
      tweetHit('https://x.com/b/status/2'),
      tweetHit('https://x.com/c/status/3'),
      tweetHit('https://x.com/d/status/4'),
    ])
    const deps: VerticalDeps = { search }
    const hits = await channel.run(makeReq('t', 3), deps)
    expect(hits.map(h => h.url)).toEqual([
      'https://x.com/a/status/1',
      'https://x.com/b/status/2',
      'https://x.com/c/status/3',
    ])
  })
})

describe('VerticalRegistry 治理面', () => {
  it('register/list 保序快照；同名替换；disposer 幂等移除', () => {
    const registry = new VerticalRegistry()
    const x1 = new XVerticalChannel()
    const x2 = new XVerticalChannel()
    const d1 = registry.register(x1)
    expect(registry.list().map(c => c.id)).toEqual([X_VERTICAL_ID])
    const d2 = registry.register(x2) // 替换语义
    d1() // 旧 disposer 不得误删新实例
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toBe(x2)
    d2()
    d2() // 幂等
    expect(registry.list()).toHaveLength(0)
  })

  it('canRun：未知 id 恒 false；存在频道则透传 canHandle 判定', () => {
    const registry = new VerticalRegistry()
    registry.register(new XVerticalChannel())
    expect(registry.canRun('nope', { ...HINTS })).toBe(false)
    expect(registry.canRun(X_VERTICAL_ID, { ...HINTS, siteFilter: 'x.com' })).toBe(true)
    expect(registry.canRun(X_VERTICAL_ID, HINTS)).toBe(false)
  })
})
