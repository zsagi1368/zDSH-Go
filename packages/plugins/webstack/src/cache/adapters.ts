/**
 * 持久层适配器（L1 落地实现，W-B-31/32）：PersistenceAdapter 的两个载体——
 *
 * - {@link FilePersistenceAdapter}：node:fs/promises 文件存储。键 sha256 前
 *   16 位作文件名、前 2 位作分桶子目录（避免单目录万级文件）；值统一为
 *   JSON 信封 `{value, storedAt, ttlMs}`。**全部操作 try/catch 不抛**——磁盘
 *   故障/权限缺失一律静默降级为 miss（i18n: webstack.cache.adapter-degraded），
 *   缓存层故障绝不放大为业务失败；
 * - {@link StorageSeamAdapter}：包宿主 SeamStorageRuntime（getItem/setItem），
 *   单键 per domain 存 JSON 映射表；同过期语义。
 *
 * 过期语义与 L0 一致：惰性清除（读到过期条目才删），无后台计时器。
 * 宁可 miss 不可错 hit（W-B-30）：信封形状不完整/JSON 损坏一律按 miss 处理。
 *
 * @module webstack/cache/adapters
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CacheDomain,
  HostSeams,
  PersistenceAdapter,
  SeamStorageRuntime,
} from '../kernel/types.ts'

/** 统一存储信封：值原样 + 写入时刻 + 写入时 TTL（毫秒）。 */
interface StoredEnvelope {
  readonly value: unknown
  readonly storedAt: number
  readonly ttlMs: number
}

/** 信封守卫：形状不完整即视为损坏条目（宁可 miss）。 */
function isEnvelope(value: unknown): value is StoredEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const rec = value as Record<string, unknown>
  return typeof rec.storedAt === 'number' && typeof rec.ttlMs === 'number' && 'value' in rec
}

/** 默认文件缓存目录：<home>/.webstack/cache（win/linux 通用 path.join）。 */
export function defaultFileCacheDir(): string {
  return join(homedir(), '.webstack', 'cache')
}

// ---------------------------------------------------------------------------
// 文件持久层
// ---------------------------------------------------------------------------

/**
 * 文件版 PersistenceAdapter（domain='all'，联合失效 = 整目录移除）。
 * 键 → sha256 前 16 位文件名 + 前 2 位分桶子目录：
 * `get("abcd...")` → `<dir>/ab/<前16位>.json`。
 */
export class FilePersistenceAdapter implements PersistenceAdapter {
  readonly domain = 'all' as const

  constructor(readonly dir: string) {}

  /** 键 → 文件绝对路径（分桶子目录 + 16 位十六进制文件名）。 */
  private fileFor(key: string): string {
    const hex = createHash('sha256').update(key).digest('hex')
    return join(this.dir, hex.slice(0, 2), `${hex.slice(0, 16)}.json`)
  }

  /** 读取：不存在/损坏/形状坏/已过期 → undefined；过期惰性删除。 */
  async get(
    key: string,
  ): Promise<{ readonly value: unknown; readonly storedAt: number } | undefined> {
    try {
      const raw = await readFile(this.fileFor(key), 'utf8')
      const envelope: unknown = JSON.parse(raw)
      if (!isEnvelope(envelope)) return undefined
      if (Date.now() - envelope.storedAt >= envelope.ttlMs) {
        await this.delete(key)
        return undefined
      }
      return { value: envelope.value, storedAt: envelope.storedAt }
    } catch {
      // ENOENT / JSON 损坏 / 权限问题：统一静默降级为 miss。
      return undefined
    }
  }

  /** 写入：mkdir -p 分桶目录后写信封；任何 I/O 故障静默吞掉（降级为 miss）。 */
  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    try {
      const file = this.fileFor(key)
      await mkdir(join(file, '..'), { recursive: true })
      const envelope: StoredEnvelope = { value, storedAt: Date.now(), ttlMs }
      await writeFile(file, JSON.stringify(envelope), 'utf8')
    } catch {
      // 磁盘故障静默降级：写失败等价于「未持久化」，L0 仍在。
    }
  }

  /** 删除：force=true 幂等；失败静默。 */
  async delete(key: string): Promise<void> {
    try {
      await rm(this.fileFor(key), { force: true })
    } catch {
      // 同上：删除失败只影响磁盘占用，不影响语义（读侧还有过期兜底）。
    }
  }

  /** 联合失效（W-B-31）：整目录递归移除；下次 set 自动重建。失败静默。 */
  async clearAll(): Promise<void> {
    try {
      await rm(this.dir, { recursive: true, force: true })
    } catch {
      // 清不掉就留着：读侧 TTL 兜底保证不会错 hit。
    }
  }
}

// ---------------------------------------------------------------------------
// 宿主 storage seam 持久层
// ---------------------------------------------------------------------------

/** SearchCache 的 scoped key 前缀（`${domain}:${key}`）之外的兜底分桶名。 */
const FALLBACK_BUCKET = '_'

/** 已知分桶全集：clearAll 时逐一清空（覆盖 SearchCache 全部域 + 兜底）。 */
const KNOWN_BUCKETS: readonly (CacheDomain | typeof FALLBACK_BUCKET)[] = [
  'search',
  'fetch',
  'vertical',
  FALLBACK_BUCKET,
]

/**
 * 宿主 SeamStorageRuntime 包装版适配器：每个 domain 一个存储键，
 * 值为 `{完整键: 信封}` 的 JSON 映射（单键 per domain，W-B-55 不落明文密钥——
 * 缓存键含 credFingerprint 而非凭据本体）。
 */
export class StorageSeamAdapter implements PersistenceAdapter {
  readonly domain = 'all' as const

  constructor(private readonly storage: SeamStorageRuntime) {}

  /** 完整键 → 所属分桶（scoped key 首个 ':' 前；无冒号落兜底桶）。 */
  private bucketOf(key: string): CacheDomain | typeof FALLBACK_BUCKET {
    const idx = key.indexOf(':')
    const head = idx === -1 ? key : key.slice(0, idx)
    return KNOWN_BUCKETS.find(b => b === head) ?? FALLBACK_BUCKET
  }

  private storageKey(bucket: CacheDomain | typeof FALLBACK_BUCKET): string {
    return `webstack.cache.${bucket}`
  }

  /** 读整个桶并逐项过信封守卫；seam 异常/JSON 损坏 → 空表（静默降级）。 */
  private async readBucket(
    bucket: CacheDomain | typeof FALLBACK_BUCKET,
  ): Promise<Map<string, StoredEnvelope>> {
    try {
      const raw = await this.storage.getItem(this.storageKey(bucket))
      if (raw === undefined || raw === '') return new Map()
      const parsed: unknown = JSON.parse(raw)
      const out = new Map<string, StoredEnvelope>()
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (isEnvelope(value)) out.set(key, value)
        }
      }
      return out
    } catch {
      return new Map()
    }
  }

  /** 写回整个桶；seam 异常静默吞掉（降级为本轮未持久化）。 */
  private async writeBucket(
    bucket: CacheDomain | typeof FALLBACK_BUCKET,
    entries: Map<string, StoredEnvelope>,
  ): Promise<void> {
    try {
      await this.storage.setItem(
        this.storageKey(bucket),
        JSON.stringify(Object.fromEntries(entries)),
      )
    } catch {
      // 静默降级：宿主 storage 故障不影响本次操作结果。
    }
  }

  async get(
    key: string,
  ): Promise<{ readonly value: unknown; readonly storedAt: number } | undefined> {
    const bucket = this.bucketOf(key)
    const entries = await this.readBucket(bucket)
    const entry = entries.get(key)
    if (entry === undefined) return undefined
    if (Date.now() - entry.storedAt >= entry.ttlMs) {
      entries.delete(key)
      await this.writeBucket(bucket, entries) // 惰性清除
      return undefined
    }
    return { value: entry.value, storedAt: entry.storedAt }
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    const bucket = this.bucketOf(key)
    const entries = await this.readBucket(bucket)
    entries.set(key, { value, storedAt: Date.now(), ttlMs })
    await this.writeBucket(bucket, entries)
  }

  async delete(key: string): Promise<void> {
    const bucket = this.bucketOf(key)
    const entries = await this.readBucket(bucket)
    if (!entries.delete(key)) return
    await this.writeBucket(bucket, entries)
  }

  async clearAll(): Promise<void> {
    for (const bucket of KNOWN_BUCKETS) {
      try {
        await this.storage.setItem(this.storageKey(bucket), '{}')
      } catch {
        // 单桶清理失败继续其余桶：尽力而为的联合失效。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 选择器
// ---------------------------------------------------------------------------

/** 设置面 cache.persist 的最小结构视图（只消费这一个字段）。 */
export interface PersistConfigView {
  readonly persist?: unknown
}

/**
 * 持久层选择器：`persist==='durable'` 才启用 L1——优先宿主 storage seam
 * （能力探测到位时），否则回落文件适配器（<home>/.webstack/cache）。
 * 其余取值（默认 'memory'）返回 undefined = 纯内存 L0。
 */
export function pickPersistence(
  config: PersistConfigView,
  seams?: HostSeams,
): PersistenceAdapter | undefined {
  if (config.persist !== 'durable') return undefined
  const storage = seams?.storage
  if (storage !== undefined) return new StorageSeamAdapter(storage)
  return new FilePersistenceAdapter(defaultFileCacheDir())
}
