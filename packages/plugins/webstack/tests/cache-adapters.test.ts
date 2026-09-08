/**
 * 缓存持久层适配器（全离线）：FilePersistenceAdapter 用临时目录实测
 * set/get/过期惰性删除/损坏 JSON 容错/clearAll 与静默降级；
 * StorageSeamAdapter 用假 seam 验证分桶与同过期语义；pickPersistence 决策矩阵。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultFileCacheDir,
  FilePersistenceAdapter,
  type PersistConfigView,
  pickPersistence,
  StorageSeamAdapter,
} from '../src/cache/adapters.ts'
import type { SeamStorageRuntime } from '../src/kernel/types.ts'

/** 每个用例独立的临时目录（os.tmpdir() + 唯一子目录），afterEach 统一清理。 */
const cleanupDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'webstack-cache-test-'))
  cleanupDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(cleanupDirs.map(dir => rm(dir, { recursive: true, force: true })))
  cleanupDirs.length = 0
})

/** 复现适配器的键→文件布局：sha256 前 2 位目录 + 前 16 位文件名。 */
function expectedFileFor(dir: string, key: string): string {
  const hex = createHash('sha256').update(key).digest('hex')
  return join(dir, hex.slice(0, 2), `${hex.slice(0, 16)}.json`)
}

// ---------------------------------------------------------------------------
// FilePersistenceAdapter
// ---------------------------------------------------------------------------

describe('FilePersistenceAdapter', () => {
  it('set/get 往返：值原样归还并携带 storedAt；domain 固定 all', async () => {
    const adapter = new FilePersistenceAdapter(await makeTempDir())
    expect(adapter.domain).toBe('all')
    const payload = { hits: [{ url: 'https://example.com/?a=1&b=2', title: 'T' }] }
    await adapter.set('search:k1', payload, 60_000)
    const got = await adapter.get('search:k1')
    expect(got?.value).toEqual(payload)
    expect(typeof got?.storedAt).toBe('number')
  })

  it('文件布局：键 sha256 前 2 位为分桶目录、前 16 位为文件名', async () => {
    const dir = await makeTempDir()
    const adapter = new FilePersistenceAdapter(dir)
    await adapter.set('fetch:k2', 'v', 60_000)
    const file = expectedFileFor(dir, 'fetch:k2')
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['storedAt', 'ttlMs', 'value'])
    expect(raw.value).toBe('v')
  })

  it('get 未写入的键 → undefined（ENOENT 静默为 miss）', async () => {
    const adapter = new FilePersistenceAdapter(await makeTempDir())
    expect(await adapter.get('nope')).toBeUndefined()
  })

  it('过期条目惰性清除：读侧 miss 且文件被删', async () => {
    const dir = await makeTempDir()
    const adapter = new FilePersistenceAdapter(dir)
    await adapter.set('search:t', { x: 1 }, 20)
    expect(await adapter.get('search:t')).toBeDefined()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await adapter.get('search:t')).toBeUndefined()
    await expect(readFile(expectedFileFor(dir, 'search:t'), 'utf8')).rejects.toThrow()
  })

  it('损坏 JSON 容错：垃圾字节按 miss 处理且不抛', async () => {
    const dir = await makeTempDir()
    const adapter = new FilePersistenceAdapter(dir)
    const file = expectedFileFor(dir, 'search:corrupt')
    await writeFile(file, '{not-json!!!', 'utf8').catch(() => undefined)
    // writeFile 可能因父目录缺失失败，先 set 再破坏。
    await adapter.set('search:corrupt', 'v', 60_000)
    await writeFile(expectedFileFor(dir, 'search:corrupt'), '}{ broken', 'utf8')
    expect(await adapter.get('search:corrupt')).toBeUndefined()
  })

  it('形状不完整的信封（缺 storedAt/ttlMs）按 miss 处理', async () => {
    const dir = await makeTempDir()
    const adapter = new FilePersistenceAdapter(dir)
    await adapter.set('search:shape', 'v', 60_000)
    await writeFile(expectedFileFor(dir, 'search:shape'), '{"value":"only"}', 'utf8')
    expect(await adapter.get('search:shape')).toBeUndefined()
  })

  it('delete 幂等移除；clearAll 整目录清空后全部 miss', async () => {
    const dir = await makeTempDir()
    const adapter = new FilePersistenceAdapter(dir)
    await adapter.set('search:a', 1, 60_000)
    await adapter.set('fetch:b', 2, 60_000)
    await adapter.delete('search:a')
    expect(await adapter.get('search:a')).toBeUndefined()
    await adapter.delete('search:a') // 幂等
    await adapter.clearAll()
    expect(await adapter.get('fetch:b')).toBeUndefined()
  })

  it('磁盘故障静默降级：dir 指向普通文件时 set/get/clearAll 全不抛', async () => {
    const base = await makeTempDir()
    const blocker = join(base, 'not-a-dir')
    await writeFile(blocker, 'x', 'utf8')
    const adapter = new FilePersistenceAdapter(join(blocker, 'sub'))
    await expect(adapter.set('k', 'v', 100)).resolves.toBeUndefined()
    expect(await adapter.get('k')).toBeUndefined()
    await expect(adapter.delete('k')).resolves.toBeUndefined()
    await expect(adapter.clearAll()).resolves.toBeUndefined()
  })

  it('defaultFileCacheDir：<home>/.webstack/cache（path.join 跨平台）', () => {
    expect(defaultFileCacheDir()).toBe(join(homedir(), '.webstack', 'cache'))
  })
})

// ---------------------------------------------------------------------------
// StorageSeamAdapter（假 seam）
// ---------------------------------------------------------------------------

/** 假 SeamStorageRuntime：Map 承载 + 可选故障注入。 */
function fakeSeam(options: { failSet?: boolean; failGet?: boolean } = {}): SeamStorageRuntime & {
  dump(): Map<string, string>
} {
  const store = new Map<string, string>()
  return {
    async getItem(key) {
      if (options.failGet === true) throw new Error('seam unavailable')
      return store.get(key)
    },
    async setItem(key, value) {
      if (options.failSet === true) throw new Error('seam unavailable')
      store.set(key, value)
    },
    dump() {
      return store
    },
  }
}

describe('StorageSeamAdapter', () => {
  it('set/get 往返；domain 固定 all', async () => {
    const adapter = new StorageSeamAdapter(fakeSeam())
    expect(adapter.domain).toBe('all')
    await adapter.set('vertical:v1', { n: 1 }, 60_000)
    const got = await adapter.get('vertical:v1')
    expect(got?.value).toEqual({ n: 1 })
  })

  it('单键 per domain：search/fetch 键落在不同存储键下', async () => {
    const seam = fakeSeam()
    const adapter = new StorageSeamAdapter(seam)
    await adapter.set('search:s1', 'a', 60_000)
    await adapter.set('fetch:f1', 'b', 60_000)
    expect([...seam.dump().keys()].sort()).toEqual([
      'webstack.cache.fetch',
      'webstack.cache.search',
    ])
    // 同桶多键共存于同一映射。
    await adapter.set('search:s2', 'c', 60_000)
    expect(await adapter.get('search:s1')).toBeDefined()
    expect(await adapter.get('search:s2')).toBeDefined()
  })

  it('无冒号键落入兜底桶 _', async () => {
    const seam = fakeSeam()
    const adapter = new StorageSeamAdapter(seam)
    await adapter.set('plainkey', 'v', 60_000)
    expect(seam.dump().has('webstack.cache._')).toBe(true)
  })

  it('过期语义与文件版一致：惰性清除后 miss', async () => {
    const adapter = new StorageSeamAdapter(fakeSeam())
    await adapter.set('search:e1', 'stale', 15)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(await adapter.get('search:e1')).toBeUndefined()
  })

  it('seam 内 JSON 损坏 → 空表 miss 不抛', async () => {
    const seam = fakeSeam()
    await seam.setItem('webstack.cache.search', 'not json{')
    const adapter = new StorageSeamAdapter(seam)
    expect(await adapter.get('search:anything')).toBeUndefined()
  })

  it('delete 双态幂等 + clearAll 清空全部已知桶', async () => {
    const seam = fakeSeam()
    const adapter = new StorageSeamAdapter(seam)
    await adapter.set('search:x', 1, 60_000)
    await adapter.delete('search:x')
    expect(await adapter.get('search:x')).toBeUndefined()
    await adapter.delete('search:x') // 幂等
    await adapter.clearAll()
    for (const key of [...seam.dump().keys()]) {
      expect(JSON.parse(seam.dump().get(key) ?? '{}')).toEqual({})
    }
  })

  it('seam 故障静默降级：set/get 均不抛、一律 miss', async () => {
    const seam = fakeSeam({ failSet: true, failGet: true })
    const adapter = new StorageSeamAdapter(seam)
    await expect(adapter.set('search:y', 1, 60_000)).resolves.toBeUndefined()
    expect(await adapter.get('search:y')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// pickPersistence 决策矩阵
// ---------------------------------------------------------------------------

describe('pickPersistence 决策矩阵', () => {
  it("persist='memory' / 缺省 → undefined（纯内存 L0）", () => {
    expect(pickPersistence({ persist: 'memory' })).toBeUndefined()
    expect(pickPersistence({ persist: undefined }, { storage: fakeSeam() })).toBeUndefined()
    expect(pickPersistence({} as PersistConfigView)).toBeUndefined()
  })

  it("persist='durable' 且 seams.storage 在位 → StorageSeamAdapter", () => {
    const storage = fakeSeam()
    const picked = pickPersistence({ persist: 'durable' }, { storage })
    expect(picked).toBeInstanceOf(StorageSeamAdapter)
    expect(picked?.domain).toBe('all')
  })

  it("persist='durable' 但 storage seam 缺席 → 文件回落（默认目录）", () => {
    const picked = pickPersistence({ persist: 'durable' })
    expect(picked).toBeInstanceOf(FilePersistenceAdapter)
    expect((picked as FilePersistenceAdapter).dir).toBe(defaultFileCacheDir())
  })

  it("persist='durable' 且 seams 本身缺席 → 文件回落", () => {
    expect(pickPersistence({ persist: 'durable' })).toBeDefined()
  })

  it('未知 persist 值保守视为内存档', () => {
    expect(pickPersistence({ persist: 'aggressive' })).toBeUndefined()
  })
})
