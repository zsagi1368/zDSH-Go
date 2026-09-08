/**
 * fusion 融合数学断言（P1）：RRF 共识累加、时效半衰期衰减、权威域乘子、
 * 同 host 多样性折扣、原样 URL 串去重与 via 合并、归一化降序输出；
 * 附 i18n kernel-p1 分册 zh/en 键奇偶一致性锁死（W-B-79）。
 */
import { describe, expect, it } from 'vitest'
import type { KernelP1I18nKey } from '../src/i18n/kernel-p1.ts'
import { kernelP1MessagesEn, kernelP1MessagesZh, kernelP1Text } from '../src/i18n/kernel-p1.ts'
import {
  AUTHORITY_DOMAINS,
  DEFAULT_FUSION_PARAMS,
  fuse,
  isAuthoritativeHost,
  RRF_K,
} from '../src/kernel/fusion.ts'
import type { FusionParams, NormalizedHit } from '../src/kernel/types.ts'

/** 固定时钟（epoch 毫秒）：衰减断言的确定性参考点。 */
const NOW = 1_800_000_000_000

function hoursAgoIso(h: number): string {
  return new Date(NOW - h * 3_600_000).toISOString()
}

function hit(
  url: string,
  engine: string,
  extra: { title?: string; publishedAt?: string } = {},
): NormalizedHit {
  return {
    url,
    title: extra.title ?? url,
    ...(extra.publishedAt === undefined ? {} : { publishedAt: extra.publishedAt }),
    provenance: { engine },
  }
}

function params(overrides: Partial<Omit<FusionParams, 'enabled'>> = {}): FusionParams {
  return { ...DEFAULT_FUSION_PARAMS, enabled: true, ...overrides }
}

describe('fuse · RRF 基础分与归一化', () => {
  it('空集输入输出空数组', () => {
    expect(fuse([], params())).toEqual([])
    expect(fuse([[], [], []], params())).toEqual([])
  })

  it('RRF k=60：贡献 = 1/(k+rank)，跨引擎共识累加', () => {
    const a = hit('https://a.example/1', 'ddg')
    const b = hit('https://b.example/2', 'ddg')
    const a2 = hit('https://a.example/1', 'bing-lite')
    const out = fuse([[a, b], [a2]], params())
    // A 组分 = 1/61 + 1/61；B = 1/62。
    expect(out[0]?.url).toBe('https://a.example/1')
    expect(out[0]?.provenance.score).toBe(1)
    const expectedB = Number((1 / (RRF_K + 2) / (2 / (RRF_K + 1))).toFixed(6))
    expect(out[1]?.url).toBe('https://b.example/2')
    expect(out[1]?.provenance.score).toBe(expectedB)
  })

  it('单集合单命中：归一化分为 1 且不改动原字段', () => {
    const a = hit('https://only.example/x', 'ddg', { title: 'T' })
    const out = fuse([[a]], params())
    expect(out).toHaveLength(1)
    expect(out[0]?.title).toBe('T')
    expect(out[0]?.provenance.score).toBe(1)
  })
})

describe('fuse · 时效半衰期衰减', () => {
  it('halfLife=24h：恰好 24h 前的发布衰减为 0.5 倍并被新鲜命中反超', () => {
    const stale = hit('https://s.example/old', 'ddg', { publishedAt: hoursAgoIso(24) })
    const fresh = hit('https://f.example/new', 'ddg')
    const out = fuse([[stale, fresh]], params({ timeDecayHalfLifeH: 24 }), NOW)
    expect(out.map(h => h.url)).toEqual(['https://f.example/new', 'https://s.example/old'])
    // stale 归一分 = (1/61 × 0.5) / (1/62) = 31/61。
    expect(out[1]?.provenance.score).toBe(Number((31 / 61).toFixed(6)))
  })

  it('无 publishedAt 的命中不衰减：千小时旧闻在同组内被大幅压低', () => {
    const fresh = hit('https://f.example/new', 'ddg')
    const ancient = hit('https://a.example/old', 'ddg', { publishedAt: hoursAgoIso(1000) })
    const out = fuse([[fresh, ancient]], params({ timeDecayHalfLifeH: 24 }), NOW)
    expect(out[0]?.url).toBe('https://f.example/new')
    // 千小时 ≈ 41.7 个半衰期 → 衰减后归一分近乎归零。
    expect(out[1]?.provenance.score ?? 1).toBeLessThan(0.001)
  })

  it('非法 publishedAt 与未来时间戳一律视为不衰减', () => {
    const garbage = hit('https://g.example/x', 'ddg', { publishedAt: 'not-a-date' })
    const future = hit('https://u.example/y', 'ddg', {
      publishedAt: new Date(NOW + 3_600_000).toISOString(),
    })
    const out = fuse([[garbage, future]], params({ timeDecayHalfLifeH: 1 }), NOW)
    // 两组均未衰减 → 纯 RRF 相对分：(1/62)/(1/61)。
    expect(out.map(h => h.provenance.score)).toEqual([
      1,
      Number((1 / (RRF_K + 2) / (1 / (RRF_K + 1))).toFixed(6)),
    ])
  })

  it('timeDecayHalfLifeH=0 关闭衰减；负值/非有限同样关闭', () => {
    const old = hit('https://o.example/x', 'ddg', { publishedAt: hoursAgoIso(240) })
    for (const halfLife of [0, -5, Number.POSITIVE_INFINITY]) {
      const out = fuse([[old]], params({ timeDecayHalfLifeH: halfLife }), NOW)
      expect(out[0]?.provenance.score).toBe(1)
    }
  })
})

describe('fuse · 权威域乘子', () => {
  it('authorityBoost=1.5 使 github.com 命中反超排名更靠前的普通域', () => {
    const gh = hit('https://github.com/org/repo', 'ddg')
    const ex = hit('https://plain.example/page', 'ddg')
    const out = fuse([[gh, ex]], params({ authorityBoost: 1.5 }))
    expect(out[0]?.url).toBe('https://github.com/org/repo')
    // ex 归一分 = (1/62) / ((1/61)×1.5) = 61/93。
    expect(out[1]?.provenance.score).toBe(Number((61 / 93).toFixed(6)))
  })

  it('isAuthoritativeHost：后缀语义覆盖子域与 .gov/.edu 顶级后缀', () => {
    for (const host of [
      'wikipedia.org',
      'en.wikipedia.org',
      'arxiv.org',
      'github.com',
      'www.nature.com',
      'science.org',
      'nasa.gov',
      'mit.edu',
    ]) {
      expect(isAuthoritativeHost(host)).toBe(true)
    }
    for (const host of [
      'example.com',
      'evil.github.io',
      'gov.evil.com',
      'arxiv.org.evil.net',
      '',
    ]) {
      expect(isAuthoritativeHost(host)).toBe(false)
    }
  })

  it('常量表内容冻结且含七个内置条目', () => {
    expect(Object.isFrozen(AUTHORITY_DOMAINS)).toBe(true)
    expect(AUTHORITY_DOMAINS).toHaveLength(7)
    expect(AUTHORITY_DOMAINS).toContain('.gov')
    expect(AUTHORITY_DOMAINS).toContain('.edu')
  })

  it('authorityBoost 非法（0/负/NaN）时不施加乘子', () => {
    const gh = hit('https://github.com/x', 'ddg')
    for (const boost of [0, -1.5, Number.NaN]) {
      const out = fuse([[gh]], params({ authorityBoost: boost }))
      expect(out[0]?.provenance.score).toBe(1)
    }
  })
})

describe('fuse · 同 host 多样性折扣', () => {
  const a1 = hit('https://a.example/1', 'ddg')
  const a2 = hit('https://a.example/2', 'ddg')
  const a3 = hit('https://a.example/3', 'ddg')
  const b1 = hit('https://b.example/1', 'ddg')

  it('discount=0.85：同 host 第 2 条起按序位幂折扣，异域插队到第 2 位', () => {
    const out = fuse([[a1, a2, a3, b1]], params({ diversityDiscount: 0.85 }))
    // 折扣前降序行走计序位：a1(1/61)、a2(1/62×0.85)、a3(1/63×0.85²)、b1(1/64)
    // → 终分排序后异域 b1 插到同 host 折价条目之前。
    expect(out.map(h => h.url)).toEqual([
      'https://a.example/1',
      'https://b.example/1',
      'https://a.example/2',
      'https://a.example/3',
    ])
    const s = (rank: number) => 1 / (RRF_K + rank)
    const expectedB1 = Number((s(4) / s(1)).toFixed(6))
    const expectedA2 = Number(((s(2) * 0.85) / s(1)).toFixed(6))
    const expectedA3 = Number(((s(3) * 0.85 ** 2) / s(1)).toFixed(6))
    expect(out[1]?.provenance.score).toBe(expectedB1)
    expect(out[2]?.provenance.score).toBe(expectedA2)
    expect(out[3]?.provenance.score).toBe(expectedA3)
  })

  it('强折扣 0.5 时异域命中插队到同 host 第 2 条之前', () => {
    const out = fuse([[a1, a2, a3, b1]], params({ diversityDiscount: 0.5 }))
    expect(out.map(h => h.url)).toEqual([
      'https://a.example/1',
      'https://b.example/1',
      'https://a.example/2',
      'https://a.example/3',
    ])
  })

  it('diversityDiscount=1 或非法值（0/负/≥1）不折扣', () => {
    for (const d of [1, 0, -0.5, Number.NaN]) {
      const out = fuse([[a1, a2]], params({ diversityDiscount: d }))
      expect(out.map(h => h.url)).toEqual(['https://a.example/1', 'https://a.example/2'])
    }
  })

  it('host 取自 URL 解析；不同 host 同域名前缀互不计序位', () => {
    const x1 = hit('https://news.a.example/1', 'ddg')
    const x2 = hit('https://news.b.example/2', 'ddg')
    const out = fuse([[x1, x2]], params({ diversityDiscount: 0.5 }))
    // host 不同 → 第二条不打折，得分并列归一后由首见序裁决。
    expect(out[1]?.provenance.score).toBe(Number((1 / 62 / (1 / 61)).toFixed(6)))
  })
})

describe('fuse · 原样 URL 串去重与 via 合并', () => {
  it('完全相同字符串跨引擎去重为一组，via 按首见序合并引擎', () => {
    const raw = 'https://Example.com/Dup'
    const out = fuse(
      [[hit(raw, 'ddg', { title: 'first' })], [hit(raw, 'bing-lite', { title: 'second' })]],
      params(),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.url).toBe(raw) // 原样保留，不改写大小写
    expect(out[0]?.provenance.via).toBe('ddg+bing-lite')
  })

  it('代表命中取组内单条综合得分最高者（衰减后的新鲜者胜出）', () => {
    const raw = 'https://rep.example/page'
    const staleFirst = hit(raw, 'ddg', { title: 'stale', publishedAt: hoursAgoIso(48) })
    const freshSecond = hit(raw, 'bing-lite', { title: 'fresh' })
    const out = fuse([[staleFirst], [freshSecond]], params({ timeDecayHalfLifeH: 24 }), NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.title).toBe('fresh')
    expect(out[0]?.publishedAt).toBeUndefined()
    expect(out[0]?.provenance.via).toBe('ddg+bing-lite')
  })

  it('仅单来源引擎重复出现时不产生合成 via（保持原有 via 缺席）', () => {
    const raw = 'https://same.engine/x'
    const out = fuse([[hit(raw, 'ddg'), hit(raw, 'ddg')]], params())
    expect(out).toHaveLength(1)
    expect(out[0]?.provenance.via).toBeUndefined()
    // 同引擎两次命中 RRF 也累加（rank1+rank2）。
    expect(out[0]?.provenance.score).toBe(1)
  })

  it('近邻但不同的原样串不合并（首见表示各自保留）', () => {
    const out = fuse(
      [[hit('https://a.example/x', 'ddg')], [hit('https://a.example/x/', 'bing-lite')]],
      params(),
    )
    expect(out.map(h => h.url)).toEqual(['https://a.example/x', 'https://a.example/x/'])
  })

  it('via 引擎清单去重：三来源两两重复只列唯一引擎', () => {
    const raw = 'https://multi.example/z'
    const out = fuse(
      [[hit(raw, 'ddg')], [hit(raw, 'searxng')], [hit(raw, 'ddg')], [hit(raw, 'bing-lite')]],
      params(),
    )
    expect(out[0]?.provenance.via).toBe('ddg+searxng+bing-lite')
  })

  it('DEFAULT_FUSION_PARAMS 与 settings schema 默认对齐（24 / 1 / 0.85）', () => {
    expect(DEFAULT_FUSION_PARAMS.enabled).toBe(true)
    expect(DEFAULT_FUSION_PARAMS.timeDecayHalfLifeH).toBe(24)
    expect(DEFAULT_FUSION_PARAMS.authorityBoost).toBe(1)
    expect(DEFAULT_FUSION_PARAMS.diversityDiscount).toBe(0.85)
  })
})

describe('i18n kernel-p1 分册 · 双语键奇偶一致（W-B-79）', () => {
  it('zh/en 键集完全一致且新增键不少于 6 个', () => {
    const zhKeys = Object.keys(kernelP1MessagesZh).toSorted()
    const enKeys = Object.keys(kernelP1MessagesEn).toSorted()
    expect(zhKeys).toEqual(enKeys)
    const p1Keys = zhKeys.filter(key => key.startsWith('webstack.kernel-p1.'))
    expect(p1Keys.length).toBeGreaterThanOrEqual(6)
    expect(p1Keys).toContain('webstack.kernel-p1.batch.limit-exceeded')
    expect(p1Keys).toContain('webstack.kernel-p1.history.cleared')
    expect(p1Keys).toContain('webstack.kernel-p1.fusion.degraded')
  })

  it('每个键的双语文案均非空；未知 locale 回落中文', () => {
    for (const key of Object.keys(kernelP1MessagesZh)) {
      const k = key as keyof typeof kernelP1MessagesZh
      expect(kernelP1MessagesZh[k].length).toBeGreaterThan(0)
      expect(kernelP1MessagesEn[k].length).toBeGreaterThan(0)
    }
    expect(kernelP1Text('webstack.kernel-p1.history.cleared')).toBe(
      kernelP1MessagesZh['webstack.kernel-p1.history.cleared'],
    )
    expect(kernelP1Text('webstack.kernel-p1.history.cleared', 'en')).toBe(
      kernelP1MessagesEn['webstack.kernel-p1.history.cleared'],
    )
  })

  it('类型面闭集 union 保持可引用（新增键必须进 KernelP1I18nKey）', () => {
    const degraded: KernelP1I18nKey = 'webstack.kernel-p1.fusion.degraded'
    const timeoutLeg: KernelP1I18nKey = 'webstack.kernel-p1.fusion.timeout-leg'
    expect(kernelP1Text(degraded)).toContain('WebStack')
    expect(kernelP1Text(timeoutLeg, 'en')).toContain('budget')
  })
})
