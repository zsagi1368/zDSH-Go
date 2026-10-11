/**
 * FB5 台账原子写判别锁（TC-B4-H1 面四，D1b §3-FB5）：writeFileAtomicSync =
 * writeFileAtomic 的同步等价形（atomic-write/src/index.ts:78-93 + renameAtomicTemp
 * 逐条镜像）。锁谱按卡面「原子形判别+半写窗口负例按可行性」：
 * - 原子形判别：独占 `wx` 随机后缀 sibling temp 承接全部内容 + rename 原子提交；
 * - 半写窗口负例（可行性形）：**目标路径永不进 writeFileSync**（旧直写形复刻
 *   必红——直写即半写可见窗本体）+ rename 非瞬态失败时旧内容完整无损坏、
 *   temp 清零、原错误重抛（调用方补偿依赖）；
 * - win32 瞬态 EACCES/EBUSY/EPERM 有界退避重试→提交成功（重试耗尽→重抛）；
 * - mode 0o600 随新 inode（台账含用户决策数据，D1b 建议原文）。
 *
 * mock 形制=symbol-isolation.spec 先例（delegate 委托原实现+注入旗标，
 * mock class 基铁律同款：不改被检模块语义，只在 fs 缝上观测/注错）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsInject = vi.hoisted(() => ({
  /** Successive renameSync calls throw these errno codes (queue, shifted per call). */
  renameFailCodes: [] as string[],
  writes: [] as Array<{ file: string; content: unknown; options: unknown }>,
  renames: [] as Array<[string, string]>,
  rms: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realWrite = actual.writeFileSync as (...args: unknown[]) => unknown
  const realRename = actual.renameSync as (...args: unknown[]) => unknown
  const realRm = actual.rmSync as (...args: unknown[]) => unknown
  const writeFileSync = ((...args: unknown[]) => {
    fsInject.writes.push({ file: String(args[0]), content: args[1], options: args[2] })
    return realWrite(...args)
  }) as unknown as typeof actual.writeFileSync
  const renameSync = ((...args: unknown[]) => {
    fsInject.renames.push([String(args[0]), String(args[1])])
    const code = fsInject.renameFailCodes.shift()
    if (code !== undefined) {
      const error = new Error(`rename ${code}`) as NodeJS.ErrnoException
      error.code = code
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

import { writeFileAtomicSync } from '../src/atomic-write-sync.ts'

const dirs: string[] = []

beforeEach(() => {
  fsInject.renameFailCodes = []
  fsInject.writes = []
  fsInject.renames = []
  fsInject.rms = []
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-sync-'))
  dirs.push(dir)
  return dir
}

/** Whether `value` is the `<target>.<12-hex>.tmp` sibling shape the mirror must use. */
function isAtomicTempOf(target: string, value: string): boolean {
  if (!value.startsWith(`${target}.`) || !value.endsWith('.tmp')) return false
  return /^[0-9a-f]{12}$/.test(value.slice(target.length + 1, value.length - '.tmp'.length))
}

describe('writeFileAtomicSync: atomic shape (FB5 判别锁)', () => {
  it('writes an exclusive random-suffix temp with mode 0o600 then renames it over the target; the target itself never enters writeFileSync', () => {
    const dir = scratch()
    const target = join(dir, 'preinstall-results.json')
    writeFileAtomicSync(target, '{"version":1}', 0o600)
    // 内容落定（mkdir+wx+rename 全链真实 fs 效应）。
    expect(readFileSync(target, 'utf8')).toBe('{"version":1}')
    // writeFileSync 恰一次，落 sibling temp：wx 独占 + mode 随 inode。
    expect(fsInject.writes).toHaveLength(1)
    const write = fsInject.writes[0]!
    expect(isAtomicTempOf(target, write.file)).toBe(true)
    expect(write.content).toBe('{"version":1}')
    expect(write.options).toEqual({ mode: 0o600, flag: 'wx' })
    // 负对照（旧直写形复刻必红）：目标路径本身永不进 writeFileSync——
    // 直写即「无锁读者半写可见」窗口本体。
    expect(fsInject.writes.some(entry => entry.file === target)).toBe(false)
    // rename 原子提交：temp→目标恰一次；无 temp 残留。
    expect(fsInject.renames).toHaveLength(1)
    expect(fsInject.renames[0]).toEqual([write.file, target])
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('creates missing parent directories (mkdir leg)', () => {
    const target = join(scratch(), 'deep', 'nested', 'approvals.json')
    writeFileAtomicSync(target, '{}', 0o600)
    expect(readFileSync(target, 'utf8')).toBe('{}')
  })
})

describe('writeFileAtomicSync: failure faces keep the previous ledger intact (半写窗口负例)', () => {
  it('non-transient rename failure: previous content intact, temp cleaned, original error rethrown', () => {
    const dir = scratch()
    const target = join(dir, 'installed-sources.json')
    writeFileAtomicSync(target, 'ORIGINAL', 0o600)
    fsInject.writes = []
    fsInject.renames = []
    fsInject.rms = []
    fsInject.renameFailCodes = ['EINVAL']
    expect(() => {
      writeFileAtomicSync(target, 'CORRUPTING', 0o600)
    }).toThrow(/rename EINVAL/)
    // 旧内容逐字节完整（墓碑载体不损坏=MM1b/P-9b 耐久语义的物理腿）。
    expect(readFileSync(target, 'utf8')).toBe('ORIGINAL')
    // temp 清理腿在位、目录零残留。
    expect(fsInject.rms).toHaveLength(1)
    expect(isAtomicTempOf(target, fsInject.rms[0]!)).toBe(true)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('transient win32 EPERM is retried with bounded backoff and commits', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const dir = scratch()
      const target = join(dir, 'registry.json')
      fsInject.renameFailCodes = ['EPERM', 'EPERM']
      writeFileAtomicSync(target, 'RETRY-OK', 0o600)
      expect(readFileSync(target, 'utf8')).toBe('RETRY-OK')
      // 两次瞬态 + 第三次真提交。
      expect(fsInject.renames).toHaveLength(3)
      expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('transient retry exhaustion (limit 8) rethrows and keeps the previous content', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const dir = scratch()
      const target = join(dir, 'registry.json')
      writeFileAtomicSync(target, 'ORIGINAL', 0o600)
      fsInject.renames = []
      fsInject.renameFailCodes = Array<string>(20).fill('EBUSY')
      expect(() => {
        writeFileAtomicSync(target, 'CORRUPTING', 0o600)
      }).toThrow(/rename EBUSY/)
      // 初次 + 8 次重试 = 9 次尝试（RENAME_RETRY_LIMIT 镜像）。
      expect(fsInject.renames).toHaveLength(9)
      expect(readFileSync(target, 'utf8')).toBe('ORIGINAL')
      expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  }, 30_000)

  it('non-win32 platform never treats EPERM as transient (fail fast, no backoff loop)', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      const dir = scratch()
      const target = join(dir, 'registry.json')
      writeFileAtomicSync(target, 'ORIGINAL', 0o600)
      fsInject.renames = []
      fsInject.renameFailCodes = ['EPERM']
      expect(() => {
        writeFileAtomicSync(target, 'CORRUPTING', 0o600)
      }).toThrow(/rename EPERM/)
      expect(fsInject.renames).toHaveLength(1)
      expect(readFileSync(target, 'utf8')).toBe('ORIGINAL')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})
