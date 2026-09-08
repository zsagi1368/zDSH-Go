/**
 * history 环形账本（P1）：环形 200（可配）、record/list/clear、
 * PersistenceAdapter write-behind + load 回放；内部动作绝不抛错
 * （适配器故障/垃圾载荷/非法条目全部静默消化）。
 */
import { describe, expect, it } from 'vitest'
import {
  HISTORY_CAPACITY_DEFAULT,
  HISTORY_STORE_KEY,
  HistoryStore,
} from '../src/kernel/history.ts'
import type { HistoryEntry, PersistenceAdapter } from '../src/kernel/types.ts'

/** 假持久层：内存 Map + 可开关故障注入 + 调用计数。 */
class FakeAdapter implements PersistenceAdapter {
  readonly domain = 'all' as const
  readonly store = new Map<string, { readonly value: unknown; readonly storedAt: number }>()
  calls = { get: 0, set: 0, delete: 0 }
  failGet = false
  failSet = false

  async get(
    key: string,
  ): Promise<{ readonly value: unknown; readonly storedAt: number } | undefined> {
    this.calls.get++
    if (this.failGet) throw new Error('adapter read failure')
    return this.store.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.calls.set++
    if (this.failSet) throw new Error('adapter write failure')
    this.store.set(key, { value, storedAt: Date.now() })
  }

  async delete(key: string): Promise<void> {
    this.calls.delete++
    this.store.delete(key)
  }

  async clearAll(): Promise<void> {
    this.store.clear()
  }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 25))

function entry(n: number, at = n): HistoryEntry {
  return {
    kind: 'search',
    at,
    input: `q${n}`,
    sources: [{ url: `https://h.example/${n}`, title: `t${n}` }],
  }
}

describe('HistoryStore · 内存环形', () => {
  it(`默认容量 ${HISTORY_CAPACITY_DEFAULT}：超限丢最旧，list 最新在前`, () => {
    const store = new HistoryStore()
    expect(HISTORY_CAPACITY_DEFAULT).toBe(200)
    for (let i = 0; i < 250; i++) store.record(entry(i))
    expect(store.size()).toBe(200)
    const listed = store.list()
    expect(listed).toHaveLength(200)
    expect(listed[0]?.input).toBe('q249')
    expect(listed[199]?.input).toBe('q50') // q0..q49 已被挤出环
    // 防御性拷贝：改返回数组不影响内部环。
    listed.length = 0
    expect(store.size()).toBe(200)
  })

  it('容量可配置：capacity=3 时只留最近 3 条', () => {
    const store = new HistoryStore({ capacity: 3 })
    for (const n of [1, 2, 3, 4, 5]) store.record(entry(n))
    expect(store.list().map(e => e.input)).toEqual(['q5', 'q4', 'q3'])
  })

  it('list(limit) 截取最新 N 条；limit<=0 返回空', () => {
    const store = new HistoryStore({ capacity: 10 })
    for (let i = 0; i < 6; i++) store.record(entry(i))
    expect(store.list(2).map(e => e.input)).toEqual(['q5', 'q4'])
    expect(store.list(0)).toEqual([])
    expect(store.list(-3)).toEqual([])
    expect(store.list()).toHaveLength(6)
  })

  it('clear 清空内存环且后续 record 正常', () => {
    const store = new HistoryStore()
    store.record(entry(1))
    store.clear()
    expect(store.size()).toBe(0)
    expect(store.list()).toEqual([])
    store.record(entry(2))
    expect(store.list()[0]?.input).toBe('q2')
  })

  it('record 非法条目被忽略而非抛错', () => {
    const store = new HistoryStore()
    store.record({ kind: 'nonsense', at: 1, input: 'x', sources: [] } as unknown as HistoryEntry)
    store.record(undefined as unknown as HistoryEntry)
    expect(store.size()).toBe(0)
  })
})

describe('HistoryStore · write-behind 持久化与 load 回放', () => {
  it('record 异步刷写快照（write-behind，不阻塞调用）', async () => {
    const adapter = new FakeAdapter()
    const store = new HistoryStore({ adapter })
    store.record(entry(1))
    store.record(entry(2))
    // 同轮多次 record 合并为一次全量刷写。
    await tick()
    expect(adapter.calls.set).toBe(1)
    const snapshot = adapter.store.get(HISTORY_STORE_KEY)?.value as HistoryEntry[]
    expect(snapshot.map(e => e.input)).toEqual(['q1', 'q2'])
  })

  it('clear 后异步把空快照落盘', async () => {
    const adapter = new FakeAdapter()
    const store = new HistoryStore({ adapter })
    store.record(entry(1))
    await tick()
    store.clear()
    await tick()
    const snapshot = adapter.store.get(HISTORY_STORE_KEY)?.value as HistoryEntry[]
    expect(snapshot).toEqual([])
  })

  it('load 从持久层回放：按 at 升序重灌、list 最新在前', async () => {
    const adapter = new FakeAdapter()
    adapter.store.set(HISTORY_STORE_KEY, {
      value: [entry(3), entry(1), entry(2)],
      storedAt: Date.now(),
    })
    const store = new HistoryStore({ adapter })
    await store.load()
    expect(store.size()).toBe(3)
    expect(store.list().map(e => e.input)).toEqual(['q3', 'q2', 'q1'])
  })

  it('load 回放遵守容量上限（截取最新 capacity 条）', async () => {
    const adapter = new FakeAdapter()
    const payload = Array.from({ length: 260 }, (_, i) => entry(i, i))
    adapter.store.set(HISTORY_STORE_KEY, { value: payload, storedAt: Date.now() })
    const store = new HistoryStore({ capacity: 100, adapter })
    await store.load()
    expect(store.size()).toBe(100)
    expect(store.list()[0]?.input).toBe('q259')
    expect(store.list()[99]?.input).toBe('q160')
  })

  it('回放载荷中的垃圾条目逐条跳过', async () => {
    const adapter = new FakeAdapter()
    adapter.store.set(HISTORY_STORE_KEY, {
      value: [entry(1), { junk: true }, null, entry(2), 'garbage', entry('x' as unknown as number)],
      storedAt: Date.now(),
    })
    const store = new HistoryStore({ adapter })
    await store.load()
    expect(store.size()).toBe(2)
    expect(store.list().map(e => e.input)).toEqual(['q2', 'q1'])
  })

  it('无适配器时 load 为无害空操作', async () => {
    const store = new HistoryStore()
    await expect(store.load()).resolves.toBeUndefined()
    store.record(entry(9))
    await store.load()
    expect(store.size()).toBe(1) // 未被清掉
  })
})

describe('HistoryStore · 内部动作绝不抛错', () => {
  it('适配器 set 故障：record/clear 照常成功，内存态完好', async () => {
    const adapter = new FakeAdapter()
    adapter.failSet = true
    const store = new HistoryStore({ adapter })
    expect(() => store.record(entry(1))).not.toThrow()
    expect(() => store.clear()).not.toThrow()
    await tick()
    expect(store.size()).toBe(0)
    store.record(entry(2))
    expect(store.list()[0]?.input).toBe('q2')
  })

  it('适配器 get 故障：load 静默保持现状', async () => {
    const adapter = new FakeAdapter()
    adapter.failGet = true
    const store = new HistoryStore({ adapter })
    store.record(entry(7))
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.size()).toBe(1)
    expect(store.list()[0]?.input).toBe('q7')
  })

  it('回放假载荷整体缺失（undefined 快照）不抛错', async () => {
    const adapter = new FakeAdapter()
    adapter.store.set(HISTORY_STORE_KEY, { value: undefined, storedAt: Date.now() })
    const store = new HistoryStore({ adapter })
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.size()).toBe(0)
  })
})
