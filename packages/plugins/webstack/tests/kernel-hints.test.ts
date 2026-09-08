/** hints 提取：纯正则双语词表的确定性提取（W-B-15，表驱动）。 */
import { describe, expect, it } from 'vitest'
import { chineseRatio, extractHints } from '../src/kernel/hints.ts'

describe('extractHints：site: 操作符', () => {
  const CASES = [
    {
      name: '英文查询带 site:',
      query: 'deepseek harness docs site:example.com',
      filter: 'example.com',
      topic: 'deepseek harness docs',
    },
    {
      name: '中文查询带 site:',
      query: '深度求索 产品页 site:deepseek.com',
      filter: 'deepseek.com',
      topic: '深度求索 产品页',
    },
    {
      name: 'site: 值统一小写',
      query: 'news site:EXAMPLE.ORG',
      filter: 'example.org',
      topic: 'news',
    },
  ] as const

  for (const c of CASES) {
    it(c.name, () => {
      const hints = extractHints(c.query)
      expect(hints.siteFilter).toBe(c.filter)
      expect(hints.topic).toBe(c.topic)
      // hard 片段保留原文大小写（原样片段语义），身份比较用小写。
      expect(hints.hard.some(h => h.toLowerCase() === `site:${c.filter}`)).toBe(true)
    })
  }

  it('无操作符时 siteFilter 缺席且 hard 不含 site 片段', () => {
    const hints = extractHints('plain query')
    expect(hints.siteFilter).toBeUndefined()
    expect(hints.hard.every(h => !h.startsWith('site:'))).toBe(true)
  })
})

describe('extractHints：时效词 → 软新鲜度（优先级 day > week > month > year）', () => {
  const CASES = [
    { query: '今天有什么新闻', freshness: 'day', word: '今天' },
    { query: 'latest ai news', freshness: 'day', word: 'latest' },
    { query: 'today headlines', freshness: 'day', word: 'today' },
    { query: '刚刚发生的', freshness: 'day', word: '刚刚' },
    { query: '本周热点', freshness: 'week', word: '本周' },
    { query: 'this week market', freshness: 'week', word: 'week' },
    { query: '本月发布', freshness: 'month', word: '本月' },
    { query: 'monthly report', freshness: 'month', word: 'month' },
    { query: '今年总结', freshness: 'year', word: '今年' },
    { query: 'year in review', freshness: 'year', word: 'year' },
    // 多词命中取最高档：本周+最新 → day。
    { query: '本周最新消息', freshness: 'day', word: '最新' },
  ] as const

  for (const c of CASES) {
    it(`${c.query} → ${c.freshness}`, () => {
      const hints = extractHints(c.query)
      expect(hints.freshness).toBe(c.freshness)
      expect(hints.soft).toContain(c.word)
    })
  }

  it('无时效词时 freshness 缺席且 soft 为空数组', () => {
    const hints = extractHints('stable query without any time words')
    expect(hints.freshness).toBeUndefined()
    expect(hints.soft).toEqual([])
  })
})

describe('extractHints：语言判定与硬片段', () => {
  const CASES = [
    { name: '中文占比过半 → zh', query: '深度求索的最新模型', locale: 'zh' },
    {
      name: '纯英文 → en',
      query: 'deepseek latest model release notes',
      locale: 'en',
    },
    {
      name: '中文字符占比 ≤30% → en',
      query: '12 个 ab deepseek',
      locale: 'en',
    },
  ] as const

  for (const c of CASES) {
    it(c.name, () => {
      expect(extractHints(c.query).locale).toBe(c.locale)
    })
  }

  it('中英混排但中文占比 >30% → zh', () => {
    expect(extractHints('deepseek 深度求索 模型 手册').locale).toBe('zh')
  })

  it('双引号短语进 hard[] 且保留在主题词内', () => {
    const hints = extractHints('exact "phrase match" here')
    expect(hints.hard).toContain('phrase match')
    expect(hints.topic).toContain('"phrase match"')
  })

  it('全角弯引号短语同样进 hard[]', () => {
    const hints = extractHints('搜索“精确短语”内容')
    expect(hints.hard).toContain('精确短语')
  })

  it('空查询：hard/soft 空数组 + en + topic 缺席', () => {
    const hints = extractHints('')
    expect(hints.topic).toBeUndefined()
    expect(hints.hard).toEqual([])
    expect(hints.soft).toEqual([])
    expect(hints.locale).toBe('en')
  })

  it('确定性：同输入两次提取结果逐字段相等（缓存键前提）', () => {
    const a = JSON.stringify(extractHints('site:a.com 今天 "quoted"'))
    const b = JSON.stringify(extractHints('site:a.com 今天 "quoted"'))
    expect(a).toBe(b)
  })
})

describe('chineseRatio', () => {
  it('全中文为 1；空串为 0；混合按去空白字符数计', () => {
    expect(chineseRatio('深度求索')).toBe(1)
    expect(chineseRatio('')).toBe(0)
    expect(chineseRatio('ab 深度')).toBeCloseTo(0.5, 5)
  })
})
