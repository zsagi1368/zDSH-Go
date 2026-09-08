/** 缓存存储：LRU 淘汰序 / 分域 TTL / 双层失效 / 统计 / singleFlight / keyFor（W-B-30~34）。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TTL_MS, keyFor, SearchCache, singleFlight } from '../src/cache/store.ts'
import type { CacheDomain, CacheKeyInput, PersistenceAdapter } from '../src/kernel/types.ts'

afterEach(() => {
  vi.useRealTimers()
})

/** 内存版 PersistenceAdapter 桩：记录写入时刻，供 TTL 复核断言。 */
function makeAdapter(): PersistenceAdapter & {
  seed(key: string, value: unknown, storedAt: number): void
  size(): number
} {
  const store = new Map<string, { value: unknown; storedAt: number }>()
  return {
    domain: 'all',
    async get(key) {
      const entry = store.get(key)
      return entry ? { value: entry.value, storedAt: entry.storedAt } : undefined
    },
    async set(key, value) {
      store.set(key, { value, storedAt: Date.now() })
    },
    async delete(key) {
      store.delete(key)
    },
    async clearAll() {
      store.clear()
    },
    seed(key, value, storedAt) {
      store.set(key, { value, storedAt })
    },
    size() {
      return store.size
    },
  }
}

describe('SearchCache · L0 LRU', () => {
  it('容量淘汰按最久未访问序：被触碰的条目存活，最旧的先出局', async () => {
    const cache = new SearchCache({ capacity: 2 })
    await cache.set('search', 'a', 1)
    await cache.set('search', 'b', 2)
    // 触碰 a → b 成为最久未访问。
    expect(await cache.get('search', 'a')).toBe(1)
    await cache.set('search', 'c', 3)
    expect(await cache.get('search', 'b')).toBeUndefined()
    expect(await cache.get('search', 'a')).toBe(1)
    expect(await cache.get('search', 'c')).toBe(3)
  })

  it('分域 TTL 默认表与规格一致：search 10min / fetch 60min / vertical 30min', () => {
    expect(DEFAULT_TTL_MS.search).toBe(10 * 60_000)
    expect(DEFAULT_TTL_MS.fetch).toBe(60 * 60_000)
    expect(DEFAULT_TTL_MS.vertical).toBe(30 * 60_000)
  })
})

describe('SearchCache · 分域 TTL', () => {
  it('search 域默认 10 分钟过期（惰性清除）', async () => {
    vi.useFakeTimers()
    const cache = new SearchCache()
    await cache.set('search', 'q', { hits: [] })
    vi.advanceTimersByTime(10 * 60_000 - 1)
    expect(await cache.get('search', 'q')).toEqual({ hits: [] })
    vi.advanceTimersByTime(1)
    expect(await cache.get('search', 'q')).toBeUndefined()
    // 惰性清除后条目已出 L0。
    expect(cache.stats().size).toBe(0)
  })

  it('分域隔离：fetch 域条目在 search 域过期点仍然存活', async () => {
    vi.useFakeTimers()
    const cache = new SearchCache()
    await cache.set('fetch', 'u', 'page')
    await cache.set('search', 'q', 'result')
    vi.advanceTimersByTime(10 * 60_000)
    expect(await cache.get('search', 'q')).toBeUndefined()
    expect(await cache.get('fetch', 'u')).toBe('page')
  })

  it('ttlOverrides 覆盖分域默认；set 显式 ttlMs 再覆盖一次', async () => {
    vi.useFakeTimers()
    const cache = new SearchCache({ ttlOverrides: { vertical: 1000 } })
    await cache.set('vertical', 'v1', 'x')
    vi.advanceTimersByTime(999)
    expect(await cache.get('vertical', 'v1')).toBe('x')
    vi.advanceTimersByTime(1)
    expect(await cache.get('vertical', 'v1')).toBeUndefined()

    await cache.set('vertical', 'v2', 'y', 50)
    vi.advanceTimersByTime(50)
    expect(await cache.get('vertical', 'v2')).toBeUndefined()
  })

  it('存原文不加工：值原样返回（含嵌套引用）', async () => {
    const cache = new SearchCache()
    const raw = { url: 'https://example.com/?a=1&b=2', nested: [1, { z: 0 }] }
    await cache.set('search', 'raw', raw)
    expect(await cache.get('search', 'raw')).toBe(raw)
  })
})

describe('SearchCache · L1 联合失效与回填', () => {
  it('clearAll 同时清空 L0 与 adapter；delete 双层同删', async () => {
    vi.useFakeTimers()
    const adapter = makeAdapter()
    const cache = new SearchCache({ adapter })
    await cache.set('search', 'k1', 'v1')
    await cache.set('fetch', 'k2', 'v2')
    expect(adapter.size()).toBe(2)

    await cache.delete('fetch', 'k2')
    expect(adapter.size()).toBe(1)
    expect(await cache.get('fetch', 'k2')).toBeUndefined()

    await cache.clearAll()
    expect(adapter.size()).toBe(0)
    expect(cache.stats().size).toBe(0)
    expect(await cache.get('search', 'k1')).toBeUndefined()
  })

  it('get 先 L0 后 adapter 回填；L1 过期残留被惰性清掉', async () => {
    vi.useFakeTimers()
    const adapter = makeAdapter()
    const cache = new SearchCache({ adapter })
    // 预置新鲜的 L1 条目（storedAt = now，未过 search 域 10 分钟 TTL）。
    // 注意：实现以 `${domain}:${key}` 作 L1 命名空间。
    adapter.seed('search:fresh', 'from-l1', Date.now())
    expect(await cache.get('search', 'fresh')).toBe('from-l1')
    // 回填后第二次读直接命中 L0（不再回源 adapter）。
    expect(await cache.get('search', 'fresh')).toBe('from-l1')
    expect(cache.stats().hits).toBe(2)

    // 预置已过期残留 → miss 且从 adapter 清除。
    adapter.seed('search:stale', 'old', Date.now() - DEFAULT_TTL_MS.search - 1)
    expect(await cache.get('search', 'stale')).toBeUndefined()
    expect(adapter.size()).toBe(1)
    expect(cache.stats().misses).toBe(1)
  })

  it('无 adapter 时纯内存可用；stats 计数命中与未命中', async () => {
    vi.useFakeTimers()
    const cache = new SearchCache()
    await cache.set('search', 'hit', 1)
    await cache.get('search', 'hit')
    await cache.get('search', 'nope')
    const stats = cache.stats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
    expect(stats.size).toBe(1)
  })
})

describe('singleFlight', () => {
  it('并发同 key 共享同一 Promise：执行函数只跑一次', async () => {
    let calls = 0
    const task = async (): Promise<number> => {
      calls++
      await new Promise<void>(resolve => queueMicrotask(resolve))
      return 42
    }
    const results = await Promise.all([
      singleFlight('sf:key', task),
      singleFlight('sf:key', task),
      singleFlight('sf:key', task),
    ])
    expect(calls).toBe(1)
    expect(results).toEqual([42, 42, 42])
  })

  it('落定后从在飞表移除：下一轮重新执行；失败同样清理且可重试', async () => {
    let calls = 0
    const ok = async (): Promise<number> => {
      calls++
      return calls
    }
    expect(await singleFlight('sf:cycle', ok)).toBe(1)
    expect(await singleFlight('sf:cycle', ok)).toBe(2)

    let failures = 0
    const boom = async (): Promise<never> => {
      failures++
      throw new Error('upstream')
    }
    const first = singleFlight('sf:fail', boom)
    const second = singleFlight('sf:fail', boom)
    const settled = await Promise.allSettled([first, second])
    expect(failures).toBe(1)
    expect(settled.every(r => r.status === 'rejected')).toBe(true)
    // 失败也移除在飞表 → 重试会真正再跑。
    await expect(singleFlight('sf:fail', boom)).rejects.toThrow('upstream')
    expect(failures).toBe(2)
  })
})

describe('keyFor', () => {
  const baseInput = (): CacheKeyInput => ({
    layer: 'free',
    engineSet: ['ddg', 'bing-lite'],
    count: 8,
    hints: { hard: [], soft: [] },
    tier: 'free',
    credFingerprint: 'ab12cd34',
  })

  it('复用 fingerprint.cacheKey 行为：同键同哈希、engineSet 序不敏感', () => {
    expect(keyFor(baseInput())).toBe(keyFor(baseInput()))
    expect(keyFor({ ...baseInput(), engineSet: ['bing-lite', 'ddg'] })).toBe(keyFor(baseInput()))
  })

  it('相邻差异换键：凭据轮换 / 层 / 数量任一变化即不同键', () => {
    const base = keyFor(baseInput())
    expect(keyFor({ ...baseInput(), credFingerprint: 'zzzz9999' })).not.toBe(base)
    expect(keyFor({ ...baseInput(), layer: 'api' })).not.toBe(base)
    expect(keyFor({ ...baseInput(), count: 9 })).not.toBe(base)
  })

  it('域维度由调用方携带：同 key 字符串跨域互不干扰', async () => {
    const domains: CacheDomain[] = ['search', 'fetch', 'vertical']
    const cache = new SearchCache()
    const key = keyFor(baseInput())
    await cache.set(domains[0]!, key, 's')
    expect(await cache.get(domains[0]!, key)).toBe('s')
    expect(await cache.get(domains[1]!, key)).toBeUndefined()
  })
})
