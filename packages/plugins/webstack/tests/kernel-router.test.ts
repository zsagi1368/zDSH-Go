/** 路由：复杂度分档边界 + planSearch 规划矩阵（W-B-12/14，表驱动）。 */
import { describe, expect, it } from 'vitest'
import {
  estimateBand,
  LAYER_ENGINE_POOL,
  normalizeLayer,
  planSearch,
} from '../src/kernel/router.ts'
import type { SearchHints, SearchLayer } from '../src/kernel/types.ts'

const HINTS: SearchHints = { topic: 'x', hard: [], soft: [] }
const CONFIG = {
  layer: 'free' as SearchLayer,
  autoFallback: true,
  fusionEnabled: true,
  complexityRouting: true,
}

describe('estimateBand 分档边界（冻结规则）', () => {
  const CASES = [
    {
      name: '16 字符无操作符 → simple',
      query: 'abcdefghijklmnop',
      band: 'simple',
    },
    { name: '17 字符 → medium', query: 'abcdefghijklmnopq', band: 'medium' },
    { name: '48 字符 → medium', query: 'a'.repeat(48), band: 'medium' },
    { name: '49 字符 → complex', query: 'b'.repeat(49), band: 'complex' },
    {
      name: '短查询含 site: 操作符 → 不再 simple',
      query: 'ab site:cdefgh',
      band: 'medium',
    },
    {
      name: '短查询含引号 → 不再 simple',
      query: '"quoted phrase"',
      band: 'medium',
    },
    { name: '首尾空白不计入长度', query: '  abcd  ', band: 'simple' },
  ] as const

  for (const c of CASES) {
    it(c.name, () => {
      expect(estimateBand(c.query)).toBe(c.band)
    })
  }
})

describe('planSearch 规划矩阵', () => {
  it('simple 单引擎；medium 两引擎；complex 全池 + fusion', () => {
    expect(planSearch(CONFIG, HINTS, 'simple')).toEqual({
      layer: 'free',
      engineIds: ['ddg'],
      fusion: false,
    })
    expect(planSearch(CONFIG, HINTS, 'medium').engineIds).toEqual(['ddg', 'bing-lite'])
    expect(planSearch(CONFIG, HINTS, 'medium').fusion).toBe(true)
    const complex = planSearch(CONFIG, HINTS, 'complex')
    expect(complex.engineIds).toEqual([...LAYER_ENGINE_POOL.free])
    expect(complex.fusion).toBe(true)
  })

  it('autoFallback=false 无论分档只返回首选单引擎且不融合', () => {
    for (const band of ['simple', 'medium', 'complex'] as const) {
      const plan = planSearch({ ...CONFIG, autoFallback: false }, HINTS, band)
      expect(plan.engineIds).toEqual(['ddg'])
      expect(plan.fusion).toBe(false)
    }
  })

  it('complexityRouting=false 一律按 medium 宽度取池', () => {
    expect(planSearch({ ...CONFIG, complexityRouting: false }, HINTS, 'complex').engineIds).toEqual(
      ['ddg', 'bing-lite'],
    )
  })

  it('fusionEnabled=false 时多引擎计划也不融合', () => {
    expect(planSearch({ ...CONFIG, fusionEnabled: false }, HINTS, 'complex').fusion).toBe(false)
  })

  it('层池映射：native→[native]、selfhosted→[searxng]、api→keyed 集（W9）、mcp 经 layerPools 动态注入', () => {
    expect(LAYER_ENGINE_POOL.native).toEqual(['native'])
    expect(LAYER_ENGINE_POOL.selfhosted).toEqual(['searxng'])
    expect(planSearch({ ...CONFIG, layer: 'api' }, HINTS, 'complex').engineIds).toEqual([
      'tavily',
      'brave',
      'exa',
      'jina',
      'firecrawl',
      'anysearch',
    ])
    expect(LAYER_ENGINE_POOL.mcp).toEqual([])
    expect(
      planSearch({ ...CONFIG, layer: 'mcp', layerPools: { mcp: ['my-mcp'] } }, HINTS, 'complex')
        .engineIds,
    ).toEqual(['my-mcp'])
  })
})

describe('normalizeLayer 层词汇守卫', () => {
  it('合法值原样保留；未知/缺席回落 free', () => {
    expect(normalizeLayer('selfhosted')).toBe('selfhosted')
    expect(normalizeLayer('free')).toBe('free')
    expect(normalizeLayer('nope')).toBe('free')
    expect(normalizeLayer(undefined)).toBe('free')
  })
})
