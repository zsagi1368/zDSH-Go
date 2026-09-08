/**
 * 缓存存储（W-B-30/31/32/34）：L0 进程内 LRU + 可选 L1 持久层 write-through
 * + 联合失效入口。设计要点：
 *
 * - **存原文不加工**（W-B-32）：`set` 收到什么就存什么，缓存层不做任何
 *   规范化/裁剪/深拷贝——加工权属于上游各层，缓存只负责「原样归还」。
 * - **先设计失效路径再分层**（W-B-31）：`clearAll()` 同时清空 L0 与 L1
 *   全部域；`delete` 双层同删；过期采用惰性清除（读到才清理，无后台计时器）。
 * - **宁可 miss 不可错 hit**（W-B-30）：键由 `keyFor()`（即 fingerprint 的
 *   `cacheKey`）从 CacheKeyInput 全维度派生；TTL 分域管理，默认
 *   search 10min / fetch 60min / vertical 30min，构造时可整体覆盖。
 *
 * MVP 决策：持久层 = PersistenceAdapter 接口占位，不引原生模块；
 * 平台 storage/snapshot 服务经能力探测后注入即可获得 L1。
 *
 * @module webstack/cache/store
 */

import type { CacheDomain, CacheKeyInput, PersistenceAdapter } from '../kernel/types.ts'
import { cacheKey } from './fingerprint.ts'

/**
 * 分域默认 TTL（毫秒）。与设置面 `cache.ttlSearchMin=10` /
 * `cache.ttlFetchMin=60` 对齐；vertical 取两者折中 30min。
 */
export const DEFAULT_TTL_MS: Readonly<Record<CacheDomain, number>> = Object.freeze({
  search: 10 * 60_000,
  fetch: 60 * 60_000,
  vertical: 30 * 60_000,
})

/** L0 LRU 默认容量上限（条目数）；构造 `capacity` 可覆盖。 */
export const L0_MAX_ENTRIES = 512

/** L0 条目：值原样存放 + 绝对过期时刻（epoch 毫秒）。 */
interface L0Entry {
  value: unknown
  expiresAt: number
}

/** 命中/未命中运行统计（`stats()` 返回形状）。 */
export interface CacheStats {
  hits: number
  misses: number
  size: number
}

/**
 * 搜索/抓取结果缓存。L0 是按访问序刷新的 Map-LRU；可选注入
 * {@link PersistenceAdapter} 作为 L1：set/delete write-through，
 * get 先查 L0、miss 后回源 L1 并回填 L0。
 */
export class SearchCache {
  private readonly l0 = new Map<string, L0Entry>()
  private readonly capacity: number
  private readonly ttlTable: Readonly<Record<CacheDomain, number>>
  private readonly adapter: PersistenceAdapter | undefined
  private hits = 0
  private misses = 0

  constructor(options?: {
    /** L0 容量上限；超限按最久未访问顺序淘汰。默认 {@link L0_MAX_ENTRIES}。 */
    capacity?: number
    /** 分域 TTL 覆盖表；未覆盖的域回落 {@link DEFAULT_TTL_MS}。 */
    ttlOverrides?: Partial<Record<CacheDomain, number>>
    /** 可选持久层适配器（L1）。缺省 = 纯内存缓存。 */
    adapter?: PersistenceAdapter
  }) {
    this.capacity = options?.capacity ?? L0_MAX_ENTRIES
    this.ttlTable = { ...DEFAULT_TTL_MS, ...options?.ttlOverrides }
    this.adapter = options?.adapter
  }

  /**
   * 读取一个条目。命中即刷新 LRU 访问序；发现已过期则惰性清除
   * （含 L1 侧的过期残留）并计一次 miss。L0 miss 时尝试 L1 回填。
   */
  async get(domain: CacheDomain, key: string): Promise<unknown> {
    const now = Date.now()
    const scoped = this.scopedKey(domain, key)
    const local = this.l0.get(scoped)
    if (local !== undefined) {
      if (now < local.expiresAt) {
        // 触碰即移到 Map 尾部 = 最近访问；Map 插入序头部即为淘汰候选。
        this.l0.delete(scoped)
        this.l0.set(scoped, local)
        this.hits++
        return local.value
      }
      this.l0.delete(scoped)
      await this.adapter?.delete(scoped)
      this.misses++
      return undefined
    }

    // L1 回源：局部常量承接以便类型收窄（await 之后属性窄化失效）。
    const adapter = this.adapter
    if (adapter === undefined) {
      this.misses++
      return undefined
    }
    const remote = await adapter.get(scoped)
    if (remote === undefined) {
      this.misses++
      return undefined
    }
    // L1 条目的 TTL 以写入时传入的毫秒数为准；这里用当前域的有效 TTL
    // 复核 storedAt（同一域内读写使用同一张表，语义一致）。
    if (now - remote.storedAt >= this.effectiveTtl(domain)) {
      await adapter.delete(scoped)
      this.misses++
      return undefined
    }
    this.admit(scoped, remote.value, now + this.effectiveTtl(domain))
    this.hits++
    return remote.value
  }

  /**
   * 写入一个条目（值**原样存放**，W-B-32）。L0 同步生效；
   * 注入了 adapter 时 write-through 到 L1。`ttlMs` 缺省用分域默认表。
   */
  async set(domain: CacheDomain, key: string, value: unknown, ttlMs?: number): Promise<void> {
    const ttl = ttlMs ?? this.effectiveTtl(domain)
    const now = Date.now()
    this.admit(this.scopedKey(domain, key), value, now + ttl)
    await this.adapter?.set(this.scopedKey(domain, key), value, ttl)
  }

  /** 删除一个条目：L0 与 L1 双层同删（幂等）。 */
  async delete(domain: CacheDomain, key: string): Promise<void> {
    const scoped = this.scopedKey(domain, key)
    this.l0.delete(scoped)
    await this.adapter?.delete(scoped)
  }

  /**
   * 联合失效入口（W-B-31）：一次性清空全部域的 L0 与 L1。
   * 引擎配置变更/凭据轮换/用户手动清理都走这里。
   */
  async clearAll(): Promise<void> {
    this.l0.clear()
    await this.adapter?.clearAll()
  }

  /** 运行统计：命中数 / 未命中数 / 当前 L0 条目数。计数器只增不清（诊断用）。 */
  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, size: this.l0.size }
  }

  /** 域的有效 TTL（毫秒）：覆盖表优先，否则默认表。 */
  private effectiveTtl(domain: CacheDomain): number {
    return this.ttlTable[domain]
  }

  /** 分域命名空间：同键字符串跨域互不串扰（宁可 miss 不可错 hit）。 */
  private scopedKey(domain: CacheDomain, key: string): string {
    return `${domain}:${key}`
  }

  /** 放入 L0 并在超容时按插入序（最久未访问）淘汰头部。 */
  private admit(key: string, value: unknown, expiresAt: number): void {
    if (this.l0.has(key)) this.l0.delete(key)
    this.l0.set(key, { value, expiresAt })
    while (this.l0.size > this.capacity) {
      const oldest = this.l0.keys().next()
      if (oldest.done) break
      this.l0.delete(oldest.value)
    }
  }
}

/** 在飞表：singleFlight 的并发去重账本（跨 SearchCache 实例共享，进程级）。 */
const inflight = new Map<string, Promise<unknown>>()

/**
 * single-flight 合并（W-B-34 配套）：并发调用同 `key` 的异步任务共享同一个
 * Promise，避免对同一资源的重复外呼；任务落定（无论成败）后从在飞表移除，
 * 后续调用开启新的一轮。
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing !== undefined) return existing as Promise<T>
  const flight: Promise<T> = fn().finally(() => {
    // 身份校验防止误删「落定后新起」的同名任务。
    if (inflight.get(key) === flight) inflight.delete(key)
  })
  inflight.set(key, flight)
  return flight
}

/**
 * 缓存键派生（W-B/boost A07 反制）：直接复用 fingerprint 的 `cacheKey`——
 * 键维度 = CacheKeyInput 字段清单，canonical JSON → sha256。本函数是唯一
 * 合法入口，禁止各层自行拼键。
 */
export function keyFor(input: CacheKeyInput): string {
  return cacheKey(input)
}
