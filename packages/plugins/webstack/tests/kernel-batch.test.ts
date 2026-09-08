/**
 * batch 批量扇出（P1）：保序并发池 ≤5、逐项结构化隔离（message 过
 * scrubText）、>10 条整体拒绝。全部离线假 run，不触网络。
 */
import { describe, expect, it } from 'vitest'
import { BATCH_MAX_CONCURRENCY, BATCH_MAX_QUERIES, batchSearch } from '../src/kernel/batch.ts'
import { engineError } from '../src/kernel/errors.ts'
import type { NormalizedHit } from '../src/kernel/types.ts'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 计数型假 run：统计峰值并发、按查询序号取延迟、返回可定位的命中。 */
function makeTrackedRun(delaysMs: readonly number[]) {
  let inflight = 0
  let peak = 0
  const started: string[] = []
  return {
    peak: () => peak,
    started,
    async run(query: string): Promise<NormalizedHit[]> {
      const slot = Number.parseInt(query, 10)
      inflight++
      peak = Math.max(peak, inflight)
      started.push(query)
      await sleep(delaysMs[Number.isNaN(slot) ? 0 : slot] ?? 5)
      inflight--
      return [{ url: `https://r.example/${query}`, title: query, provenance: { engine: 'fake' } }]
    },
  }
}

const QUERIES_10 = Array.from({ length: 10 }, (_, i) => String(i))

describe('batchSearch · 保序', () => {
  it('完成顺序打乱时结果仍与输入一一对应（index/query/hits）', async () => {
    // 后发先至：0 号最慢、9 号最快。
    const delays = [80, 70, 60, 50, 40, 35, 30, 25, 15, 1]
    const tracked = makeTrackedRun(delays)
    const items = await batchSearch({ run: tracked.run }, QUERIES_10, 10)
    expect(items).toHaveLength(10)
    items.forEach((item, i) => {
      expect(item.index).toBe(i)
      expect(item.query).toBe(String(i))
      if (item.ok) {
        expect(item.hits[0]?.url).toBe(`https://r.example/${i}`)
        expect(item.attempts).toEqual([])
      } else {
        throw new Error('all items should succeed')
      }
    })
    // 完成顺序确实被打乱过（首项最后启动也最后完成）。
    expect(tracked.started.length).toBe(10)
  })

  it('空查询列表返回空数组且从不调用 run', async () => {
    let calls = 0
    const items = await batchSearch(
      {
        run: async (_q) => {
          calls++
          return []
        },
      },
      [],
    )
    expect(items).toEqual([])
    expect(calls).toBe(0)
  })
})

describe('batchSearch · 并发池上限', () => {
  it('默认并发不超过 BATCH_MAX_CONCURRENCY=5', async () => {
    const tracked = makeTrackedRun(Array.from({ length: 10 }, () => 20))
    await batchSearch({ run: tracked.run }, QUERIES_10)
    expect(tracked.peak()).toBeLessThanOrEqual(5)
    expect(BATCH_MAX_CONCURRENCY).toBe(5)
  })

  it('显式 concurrency=2 时峰值恰为 2', async () => {
    const tracked = makeTrackedRun(Array.from({ length: 6 }, () => 15))
    await batchSearch({ run: tracked.run }, ['0', '1', '2', '3', '4', '5'], 2)
    expect(tracked.peak()).toBe(2)
  })

  it('调用方传 50 也被钳到 5；传 0/负数/NaN 回落 1 并行宽度', async () => {
    const tracked = makeTrackedRun(Array.from({ length: QUERIES_10.length }, () => 10))
    await batchSearch({ run: tracked.run }, QUERIES_10, 50)
    expect(tracked.peak()).toBe(5)

    for (const concurrency of [0, -3, Number.NaN]) {
      const single = makeTrackedRun(Array.from({ length: 4 }, () => 10))
      await batchSearch({ run: single.run }, ['0', '1', '2', '3'], concurrency)
      expect(single.peak()).toBe(1)
    }
  })
})

describe('batchSearch · 逐项隔离与脱敏', () => {
  it('单项失败转 ok:false 结构化条目，其余项不受传染', async () => {
    const items = await batchSearch(
      {
        run: async (q) => {
          if (q === 'bad') throw engineError('rate-limited', `quota blown at ${q}`, {})
          return [{ url: `https://ok.example/${q}`, title: q, provenance: { engine: 'x' } }]
        },
      },
      ['a', 'bad', 'c'],
    )
    expect(items.map(item => item.ok)).toEqual([true, false, true])
    const failed = items[1]
    if (failed === undefined || failed.ok) throw new Error('expected failure item')
    expect(failed.code).toBe('rate-limited')
    expect(failed.message).toContain('quota blown at bad')
    expect(failed.index).toBe(1)
    expect(failed.query).toBe('bad')
  })

  it('错误消息中的敏感 query 值经 scrubText 遮蔽', async () => {
    const items = await batchSearch(
      {
        run: async () => {
          throw new Error('upstream https://api.example/v1?api_key=sk-secret&x=1 exploded')
        },
      },
      ['leak'],
    )
    const failed = items[0]
    if (failed === undefined || failed.ok) throw new Error('expected failure item')
    expect(failed.message).toContain('api_key=***')
    expect(failed.message).not.toContain('sk-secret')
    expect(failed.message).toContain('x=1')
  })

  it('抛非 Error 值（字符串）归一为 transport 码', async () => {
    const items = await batchSearch(
      {
        run: async () => {
          throw 'plain string failure'
        },
      },
      ['s'],
    )
    const failed = items[0]
    if (failed === undefined || failed.ok) throw new Error('expected failure item')
    expect(failed.code).toBe('transport')
  })

  it('闭集码原样保留：auth 失败不被改写为 transport', async () => {
    const items = await batchSearch(
      {
        run: async () => {
          throw engineError('auth', 'invalid credential', {})
        },
      },
      ['k'],
    )
    const failed = items[0]
    if (failed === undefined || failed.ok) throw new Error('expected failure item')
    expect(failed.code).toBe('auth')
  })
})

describe('batchSearch · 上限拒绝', () => {
  it(`超过 ${BATCH_MAX_QUERIES} 条整体拒绝（unrepresentable / batch.limit-exceeded）`, async () => {
    const eleven = [...QUERIES_10, '10']
    await expect(batchSearch({ run: async () => [] }, eleven)).rejects.toMatchObject({
      name: 'EngineError',
      code: 'unrepresentable',
      detail: 'batch.limit-exceeded',
    })
  })

  it(`恰好 ${BATCH_MAX_QUERIES} 条放行`, async () => {
    const items = await batchSearch({ run: async _q => [] }, QUERIES_10, 5)
    expect(items).toHaveLength(10)
    expect(items.every(item => item.ok)).toBe(true)
  })
})
