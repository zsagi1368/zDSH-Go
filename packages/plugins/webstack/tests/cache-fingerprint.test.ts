/** 缓存语义指纹相邻差异（W-B/boost A07 反制）：同键必同哈希，任一维度变即换哈希。 */
import { describe, expect, it } from 'vitest'
import { cacheKey, canonicalStringify } from '../src/cache/fingerprint.ts'
import type { CacheKeyInput } from '../src/kernel/types.ts'

function baseInput(): CacheKeyInput {
  return {
    layer: 'free',
    engineSet: ['ddg', 'bing-lite'],
    count: 8,
    hints: { hard: [], soft: [] },
    tier: 'free',
    credFingerprint: 'ab12cd34',
  }
}

describe('cacheKey 相邻差异', () => {
  it('相同输入（含键序差异）→ 相同指纹', () => {
    expect(cacheKey(baseInput())).toBe(cacheKey(baseInput()))
    expect(cacheKey({ ...baseInput(), engineSet: ['bing-lite', 'ddg'] })).toBe(
      cacheKey(baseInput()),
    )
    expect(canonicalStringify({ b: 1, a: [2, { z: 3, y: 4 }] })).toBe(
      canonicalStringify({ a: [2, { y: 4, z: 3 }], b: 1 }),
    )
  })

  it('任一维度变化 → 指纹改变（宁可 miss 不可错 hit）', () => {
    const base = cacheKey(baseInput())
    expect(cacheKey({ ...baseInput(), layer: 'api' })).not.toBe(base)
    expect(cacheKey({ ...baseInput(), count: 9 })).not.toBe(base)
    expect(cacheKey({ ...baseInput(), tier: 'keyed' })).not.toBe(base)
    expect(cacheKey({ ...baseInput(), credFingerprint: 'zzzz9999' })).not.toBe(base)
    expect(cacheKey({ ...baseInput(), engineSet: ['ddg'] })).not.toBe(base)
    expect(
      cacheKey({
        ...baseInput(),
        hints: { hard: ['site:example.com'], soft: [] },
      }),
    ).not.toBe(base)
    expect(cacheKey({ ...baseInput(), options: { safe: true } })).not.toBe(base)
  })
})
