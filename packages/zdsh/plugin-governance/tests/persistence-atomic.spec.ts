/**
 * Kernel registry-snapshot atomic save locks (FB5, TC-B4-H1 面四).
 *
 * plugin-persistence.save() 的写盘形从「mkdir+writeFileSync 直写」切为文件内
 * 私有同步原子镜像（随机后缀 sibling temp + wx 独占 + mode 0o600 + rename
 * 原子提交 + win32 瞬态有界重试 + 失败清 temp 重抛）——kernel「零新增包依赖」
 * 纪律下的 writeFileAtomic 等价形（勘误与定夺见 RECEIPT-H1 §2.2）。
 *
 * 锁谱（卡面「原子形判别+半写窗口负例按可行性」）：
 * - 判别：registry.json 本体永不进 writeFileSync（直写=崩溃半写窗本体，
 *   load() 无 catch〔FB17 登记面〕损坏即 throw=旧形复刻必红负对照）；
 *   temp 形=wx+0o600+随机后缀；rename 提交恰一次；零 temp 残留；
 * - 负例：rename 非瞬态失败→旧快照逐字节完整+temp 清零+原错误重抛
 *   （调用方〔host persistRegistryChange 同步补偿链〕依赖面）。
 *
 * mock 形制=symbol-isolation.spec 先例（delegate 委托原实现+注入旗标）。
 * 独立新 spec，persistence.spec.ts 既有 29 例零改动。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsInject = vi.hoisted(() => ({
  /** When set, every renameSync throws with this errno code. */
  renameFailCode: null as string | null,
  writes: [] as Array<{ file: string; options: unknown }>,
  renames: [] as Array<[string, string]>,
  rms: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realWrite = actual.writeFileSync as (...args: unknown[]) => unknown
  const realRename = actual.renameSync as (...args: unknown[]) => unknown
  const realRm = actual.rmSync as (...args: unknown[]) => unknown
  const writeFileSync = ((...args: unknown[]) => {
    fsInject.writes.push({ file: String(args[0]), options: args[2] })
    return realWrite(...args)
  }) as unknown as typeof actual.writeFileSync
  const renameSync = ((...args: unknown[]) => {
    fsInject.renames.push([String(args[0]), String(args[1])])
    if (fsInject.renameFailCode !== null) {
      const error = new Error(`rename ${fsInject.renameFailCode}`) as NodeJS.ErrnoException
      error.code = fsInject.renameFailCode
      throw error
    }
    return realRename(...args)
  }) as unknown as typeof actual.renameSync
  const rmSync = ((...args: unknown[]) => {
    fsInject.rms.push(String(args[0]))
    return realRm(...args)
  }) as unknown as typeof actual.rmSync
  return { ...actual, writeFileSync, renameSync, rmSync }
})

import { PluginPersistence } from '../src/persistence/index.ts'
import { DefaultPluginRegistry } from '../src/registry/registry.ts'
import { BasePlugin } from '../src/base/base.ts'
import { mockContext, testManifest } from './fixtures.ts'

class NoopPlugin extends BasePlugin {
  async install() {}
}

async function populatedRegistry(): Promise<DefaultPluginRegistry> {
  const registry = new DefaultPluginRegistry()
  const result = await registry.register(new NoopPlugin(testManifest(), mockContext()))
  if (!result.success) throw new Error('fixture registration failed')
  return registry
}

const dirs: string[] = []

beforeEach(() => {
  fsInject.renameFailCode = null
  fsInject.writes = []
  fsInject.renames = []
  fsInject.rms = []
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'persist-atomic-'))
  dirs.push(dir)
  return dir
}

describe('PluginPersistence.save() atomic replacement (FB5)', () => {
  it('commits through an exclusive sibling temp; the registry path itself never enters writeFileSync', async () => {
    const root = scratch()
    const persistence = new PluginPersistence(await populatedRegistry(), { storageRoot: root, autoSave: false })
    persistence.save()
    // 内容落定（真实 fs 效应，快照字节形零变化=既有 round-trip 谱不受扰）。
    expect(readFileSync(persistence.registryPath, 'utf-8')).toContain('"version": "1.0.0"')
    // 负对照（旧直写形复刻必红）：registry.json 本体永不进 writeFileSync。
    expect(fsInject.writes.some(entry => entry.file === persistence.registryPath)).toBe(false)
    // 随机后缀 sibling temp + wx 独占 + mode 0o600 随新 inode。
    const tempWrites = fsInject.writes.filter(
      entry => entry.file.startsWith(`${persistence.registryPath}.`) && entry.file.endsWith('.tmp'),
    )
    expect(tempWrites).toHaveLength(1)
    expect(tempWrites[0]!.options).toMatchObject({ mode: 0o600, flag: 'wx' })
    // rename 原子提交恰一次 + 零 temp 残留。
    expect(fsInject.renames).toHaveLength(1)
    expect(fsInject.renames[0]![1]).toBe(persistence.registryPath)
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('a failed rename leaves the previous snapshot byte-intact, cleans the temp, and rethrows', async () => {
    const root = scratch()
    const persistence = new PluginPersistence(await populatedRegistry(), { storageRoot: root, autoSave: false })
    persistence.save()
    const before = readFileSync(persistence.registryPath, 'utf-8')
    fsInject.renames = []
    fsInject.rms = []
    fsInject.renameFailCode = 'EINVAL' // 非瞬态：即刻重抛，零重试（win32 分支同样 fail-fast）
    expect(() => {
      persistence.save()
    }).toThrow(/rename EINVAL/)
    // 旧快照逐字节完整（持久决策载体不损坏=MM1b「持久 disabled 不复活」物理腿）。
    expect(readFileSync(persistence.registryPath, 'utf-8')).toBe(before)
    // temp 清理腿在位、目录零残留。
    expect(fsInject.rms).toHaveLength(1)
    expect(String(fsInject.rms[0])).toMatch(/\.tmp$/)
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
