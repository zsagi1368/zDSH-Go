/**
 * SymbolIsolationCheck 验收套件（TC-B4-G1：A-1.2.1 / A-1.2.2 / A-1.2.3 /
 * K-1.2.1 出厂集零误杀硬门 / 验收-7 性能断言）。
 *
 * fixture 同源声明（卡面验收 1「底稿引用」条款兑现，PROGRESS:15）：
 * - 双副本红底稿 = dsh-guard `test/run.mjs` T6 共享设计（两仓共享设计不共享代码）：
 *   面 A profile 双物理副本（官方层 rc.7 真目录 + profile 层 rc.6 真目录）；
 *   面 B 治理存储区 `installed/demo/trojan{,2}` 两级权威布局内嵌
 *   `@assistant-ai/dsh-client-store` `9.9.9-fake-tc-b0` 真实目录 —— 引用
 *   `sandbox-b0/probe-npm-dual-copy.spec.mts` 底稿（FAKE_STORE_PKG 同形）。
 * - 三解析面绿底稿 = T7 共享设计（面1 树内 pnpm workspace 仿形 / 面2 发布安装
 *   profile junction→官方层仿形 / 面3 治理存储区 peer-clean+链接形核心包仿形）。
 * - 面2 载体 = `symbol-isolation-node-runtime.ts`（tsx + 隔离 cwd + 空 tsconfig
 *   覆写 + NODE_PATH=''，裸 node ESM 解析语义；R3-13 自名 import 翻转实测腿=self-name）。
 *
 * 语义保真对照（只读参照，本体不进树）：`G:\000Github\zDSH\zDSH-plugins\dsh-guard\dsh-guard.mjs`
 * isSymlink(:112)/scanCoreDuplicates(:131) junction/symlink=正常、`.dsh-guard-backup` 不回扫。
 *
 * M3 硬条款：本文件=独立新 spec，零改动既有 test 文件。
 * 全部 tmpdir fixture 自建自收（mkdtemp 前缀 `g1-symiso-`，afterAll 自清；
 * junction 清理=unlink 链接本体不跟随，目标树零触碰）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoadGuard, getSymbolIsolationScanStats, resetSymbolIsolationCacheForTest } from '../src/guards/load-guard.ts'
import type { Plugin } from '../src/spec/index.ts'
import { testManifest } from './fixtures.ts'

/* ------------------------------------------------------------------ *
 * A-1.2.3 异常注入（卡面「mock fs 抛错形」）：readdirSync 委托原实现，
 * 仅当注入激活且目标路径含 fixture marker 时抛注入载荷。
 * ------------------------------------------------------------------ */

const fsInject = vi.hoisted(() => ({
  active: false,
  marker: '',
  payload: (): unknown => new Error('injected'),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const delegate = actual.readdirSync as unknown as (...args: unknown[]) => unknown
  const readdirSync = ((...args: unknown[]) => {
    const target = String(args[0])
    if (fsInject.active && target.includes(fsInject.marker)) throw fsInject.payload()
    return delegate(...args)
  }) as unknown as typeof actual.readdirSync
  return { ...actual, readdirSync }
})

/* ------------------------------------------------------------------ *
 * 共享基元
 * ------------------------------------------------------------------ */

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..')
const factoryNmInRepo = join(repoRoot, 'packages', 'zdsh', 'factory-bundle', 'node_modules')
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const helperPath = join(import.meta.dirname, 'symbol-isolation-node-runtime.ts')
const libEntry = join(repoRoot, 'packages', 'zdsh', 'plugin-governance', 'lib', 'index.js')
const seedPath = join(repoRoot, 'zdsh-factory', 'seed.json')

const createdRoots: string[] = []

function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `g1-symiso-${tag}-`))
  createdRoots.push(root)
  return root
}

function write(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

function pkgJson(dir: string, name: string, version: string): void {
  write(join(dir, 'package.json'), JSON.stringify({ name, version }))
}

/** 目录链接：win32=junction（无需特权），POSIX 忽略 type 参=普通 symlink（dsh-guard T7 同形）。 */
function linkDir(target: string, linkPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, 'junction')
}

function linkFile(target: string, linkPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath)
}

function pluginFor(id: string): Plugin {
  return { manifest: testManifest({ id }), install(): void {} }
}

/** 出厂集八件（O3 后谱，seed.json=唯一真相源；≥8 断言防谱系静默缩水）。 */
interface SeedEntry {
  id: string
  package: string
}

function readSeedEntries(): SeedEntry[] {
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as { entries?: unknown }
  if (!Array.isArray(seed.entries)) throw new Error('seed.json entries 非数组：出厂谱漂移，K-1.2.1 面需重审')
  return seed.entries.map((entry) => {
    const e = entry as SeedEntry
    return { id: e.id, package: e.package }
  })
}

/** 断言用：symbol-isolation 检查的失败条目（区别于其余四检）。 */
function symFailures(result: { failures: Array<{ message: string }> }): string[] {
  return result.failures.filter(f => f.message.startsWith('symbol-isolation')).map(f => f.message)
}

beforeEach(() => {
  resetSymbolIsolationCacheForTest()
  fsInject.active = false
  fsInject.marker = ''
})

afterEach(() => {
  vi.unstubAllEnvs()
  fsInject.active = false
  fsInject.marker = ''
  resetSymbolIsolationCacheForTest()
})

afterAll(() => {
  for (const root of createdRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ *
 * fixture 构造器
 * ------------------------------------------------------------------ */

/**
 * kitchen-sink 全绿形（结构分支全覆盖面）：
 * - 判据1：dsh-tools 真目录 X 三视图（根 nm 真目录 + 官方层 junction + profile 层
 *   junction，同 realpath=单一目标=正常）；cosmokit 真目录 Y（.pnpm store 条目内）
 *   双 junction 视图（根 nm + .pnpm hoisted 层）；BROKEN 悬空 junction（realpath 不可
 *   解析=跳过）；file-link（终点=文件非目录=跳过）；作用域内散文件（非包视图）；
 *   .pnpm 非 @assistant-ai+ 前缀条目（store 过滤）；@assistant-ai+dsh-client-store@9.9.9
 *   单实例 store 条目（sandbox-b0 FAKE_STORE_PKG 同形、单实例=绿）。
 * - 判据2：factory nm 散文件/.bin 无 package.json 条目/dsh-demo 工件（外置字面 import
 *   正常形 + .d.ts/.map 非运行时后缀 + chunk 子目录 + lib 2 枚 cordis 键<阈值3 +
 *   packages/* monorepo 形 + packages 下散文件）。
 * - 判据3：installed 两级布局（ns 层散文件 + plugin 层散文件 + clean-plugin〔walk 级
 *   junction 跳过 + .dsh-guard-backup 不回扫 + node_modules/some-dep 真目录深潜 +
 *   作用域内 cordis junction 跳过 + 作用域内散文件〕+ data-plugin〔树根级 @assistant-ai
 *   目录（非 node_modules 下）递归不误判〕）。
 */
function buildKitchenSink(): string {
  const root = makeRoot('green')
  const nm = join(root, 'node_modules')
  const scope = join(nm, '@deepseek-ai')
  const pnpm = join(nm, '.pnpm')

  // junction 目标区（扫描面外）
  pkgJson(join(root, 'outside', 'core', 'cordis'), '@deepseek-ai/cordis', '0.1.0')
  write(join(root, 'outside', 'real-dep', 'dep.js'), 'export const dep = 1\n')
  write(join(root, 'misc', 'target-file.txt'), 'not a directory\n')

  // 判据1：单实例多视图（junction/symlink 单一目标=正常）
  pkgJson(join(scope, 'dsh-tools'), '@deepseek-ai/dsh-tools', '0.1.0-rc.7') // 实例 X（真目录）
  const realY = join(pnpm, 'cosmokit@1.0.0', 'node_modules', '@deepseek-ai', 'cosmokit')
  pkgJson(realY, '@deepseek-ai/cosmokit', '0.1.0-rc.7') // 实例 Y（store 条目内真目录）
  linkDir(realY, join(scope, 'cosmokit')) // 视图1 → Y
  linkDir(realY, join(pnpm, 'node_modules', '@deepseek-ai', 'cosmokit')) // hoisted 视图2 → Y（同终点=单实例）
  // BROKEN 悬空链接：先 junction 后删目标（win32 junction 创建需目标存在；悬空后 realpath=ENOENT）
  mkdirSync(join(root, 'outside', 'vanished'), { recursive: true })
  linkDir(join(root, 'outside', 'vanished'), join(scope, 'broken-link'))
  rmSync(join(root, 'outside', 'vanished'), { recursive: true, force: true })
  linkFile(join(root, 'misc', 'target-file.txt'), join(scope, 'file-link')) // 终点=文件（非目录实例）
  write(join(scope, 'notes.txt'), 'stray file in scope dir\n') // 作用域内散文件（非包视图）
  write(join(pnpm, 'some-pkg@1.0.0', 'readme.md'), 'non-core store entry\n') // 非 @assistant-ai+ 前缀
  // sandbox-b0 FAKE_STORE_PKG 同形 store 条目（单实例=绿；引用底稿见文件头）
  const fakeStore = join(pnpm, '@deepseek-ai+dsh-client-store@9.9.9-fake-tc-b0', 'node_modules', '@deepseek-ai', 'dsh-client-store')
  pkgJson(fakeStore, '@deepseek-ai/dsh-client-store', '9.9.9-fake-tc-b0')
  write(join(fakeStore, 'index.js'), "export const marker = 'FAKE'\n")

  // profiles 形（官方层 + profile 层，均 junction→X 单一目标）
  write(join(root, 'profiles', 'readme.txt'), 'stray file at profiles level\n')
  linkDir(join(scope, 'dsh-tools'), join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools'))
  write(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', scripts: {} }))
  linkDir(join(scope, 'dsh-tools'), join(root, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools'))

  // 出厂 bundle 区仿形
  const fnm = join(root, 'packages', 'zdsh', 'factory-bundle', 'node_modules')
  write(join(fnm, '.modules.yaml'), 'hoist-pattern: []\n') // nm 根散文件
  mkdirSync(join(fnm, '.bin'), { recursive: true }) // 无 package.json 目录条目
  const demo = join(fnm, 'dsh-demo')
  pkgJson(demo, 'dsh-demo', '1.0.0')
  write(join(demo, 'dist', 'index.js'), 'import { Context } from "@deepseek-ai/cordis";\nexport const engine = 1\n//# sourceMappingURL=index.js.map\n') // 外置字面 import=正常形，E1 永不命中
  write(join(demo, 'dist', 'index.d.ts'), 'export declare const engine: number\n') // 非运行时后缀
  write(join(demo, 'dist', 'index.js.map'), '{"version":3}\n') // 非运行时后缀
  write(join(demo, 'dist', 'chunks', 'sub.js'), 'export const sub = 1\n') // chunk 子目录递归
  write(join(demo, 'lib', 'index.js'), 'export const a = Symbol.for("cordis.g1Alpha")\nexport const b = Symbol.for("cordis.g1Beta")\n') // 2 枚键<阈值3（interop 探针形，非拷贝）
  write(join(demo, 'packages', 'stray.txt'), 'stray file under packages\n')
  write(join(demo, 'packages', 'sub-a', 'lib', 'index.js'), 'export const a = 1\n') // monorepo 一层形

  // 治理存储区（DSH_HOME 派生 <root>/zdsh）
  const installed = join(root, 'zdsh', 'installed')
  write(join(installed, 'registry.json'), '{}\n') // ns 层散文件
  write(join(installed, 'demo', 'meta.json'), '{}\n') // plugin 层散文件
  const clean = join(installed, 'demo', 'clean-plugin')
  pkgJson(clean, '@demo/clean-plugin', '1.0.0')
  linkDir(join(root, 'outside', 'real-dep'), join(clean, 'link-out')) // walk 级 junction=不跟随
  write(join(clean, '.dsh-guard-backup', 'kept.txt'), 'backup area, never rescanned\n')
  write(join(clean, 'node_modules', 'some-dep', 'dep.js'), 'export const dep = 1\n') // 普通依赖真目录=深潜无害
  linkDir(join(root, 'outside', 'core', 'cordis'), join(clean, 'node_modules', '@deepseek-ai', 'cordis')) // 链接形核心包=正常
  write(join(clean, 'node_modules', '@deepseek-ai', 'lock.yaml'), 'stray\n') // 作用域内散文件
  write(join(installed, 'demo', 'data-plugin', '@deepseek-ai', 'inner.txt'), 'scope-named dir NOT under node_modules\n') // CORE_SCOPE 名但 basename≠node_modules → 递归不收集
  write(join(installed, 'demo', 'data-plugin', '@deepseek-ai', 'deep', 'x.txt'), 'deep file\n')
  return root
}

/**
 * A-1.2.1 红底稿（dsh-guard T6 同源共享设计 + sandbox-b0 probe 底稿引用）：
 * 面 A=profile 双物理副本（官方层 rc.7 + web 层 rc.6 真目录）+ 假 .pnpm 双实例
 * （cosmokit 0.1.0/0.2.0 两 store 条目真目录=同包名 2 可解析真实实例）；
 * 面 B=存储区 installed/demo/trojan{,2} 内嵌 FAKE_STORE_PKG 同形真实副本。
 */
function buildRedDual(): string {
  const root = makeRoot('red-dual')
  pkgJson(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools'), '@deepseek-ai/dsh-tools', '0.1.0-rc.7')
  pkgJson(join(root, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools'), '@deepseek-ai/dsh-tools', '0.1.0-rc.6')
  write(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', scripts: {} }))
  const pnpm = join(root, 'node_modules', '.pnpm')
  pkgJson(join(pnpm, '@deepseek-ai+cosmokit@0.1.0', 'node_modules', '@deepseek-ai', 'cosmokit'), '@deepseek-ai/cosmokit', '0.1.0')
  pkgJson(join(pnpm, '@deepseek-ai+cosmokit@0.2.0', 'node_modules', '@deepseek-ai', 'cosmokit'), '@deepseek-ai/cosmokit', '0.2.0')
  // 面 B：sandbox-b0/probe-npm-dual-copy.spec.mts FAKE_STORE_PKG 同形（引用底稿）
  for (const plugin of ['trojan', 'trojan2']) {
    const tree = join(root, 'zdsh', 'installed', 'demo', plugin)
    pkgJson(tree, `@demo/${plugin}`, '1.0.0')
    const fake = join(tree, 'node_modules', '@deepseek-ai', 'dsh-client-store')
    write(join(fake, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-client-store',
      version: '9.9.9-fake-tc-b0',
      type: 'module',
      main: 'index.js',
      exports: './index.js',
    }))
    write(join(fake, 'index.js'), "export const marker = 'FAKE'\nexport function createSnapshotStore() { throw new Error('FAKE CORE COPY') }\n")
  }
  return root
}

/** 判据2 红底稿：factory 工件 E1+E2 双证据 + 存储区 installed 工件 E1（@ 前缀 id 翻转面）。 */
function buildRedEmbed(): string {
  const root = makeRoot('red-embed')
  const evil = join(root, 'packages', 'zdsh', 'factory-bundle', 'node_modules', 'dsh-evil')
  pkgJson(evil, 'dsh-evil', '6.6.6')
  write(join(evil, 'dist', 'bundle.js'), 'const inlined = require("./node_modules/@deepseek-ai/cordis/dist/index.js");\nmodule.exports = inlined\n') // E1 内联源路径痕迹
  write(join(evil, 'lib', 'copy.js'), 'const a = Symbol.for("cordis.evilA"); const b = Symbol.for("cordis.evilB"); const c = Symbol.for("cordis.evilC"); export default [a,b,c]\n') // E2 注册键×3 ≥阈值
  const trojan = join(root, 'zdsh', 'installed', 'demo', 'trojan')
  pkgJson(trojan, '@demo/trojan', '1.0.0')
  write(join(trojan, 'dist', 'bundle.js'), 'import "./node_modules/@deepseek-ai/schemastery/lib/index.js"\n') // 存储区工件 E1
  return root
}

/** A-1.2.3 注入底稿：最小可触发 readdirSync 的结构（profiles 目录 + 作用域目录）。 */
function buildFailClosedHost(): string {
  const root = makeRoot('fail-closed')
  mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
  mkdirSync(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
  mkdirSync(join(root, 'zdsh', 'installed', 'demo', 'x-plugin'), { recursive: true })
  return root
}

/** 面2 绿底稿（dsh-guard T7 面2 同源）：发布安装 profile 仿形，profile 层 junction→官方层单一目标。 */
function buildReleaseProfile(): string {
  const root = makeRoot('release')
  const official = join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools')
  pkgJson(official, '@deepseek-ai/dsh-tools', '0.1.0-rc.7')
  linkDir(official, join(root, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools'))
  write(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', scripts: {} }))
  write(join(root, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
  return root
}

/** 面3 存储底稿（T7 面3 同源 + K-1.2.1 八件 junction 工件腿）。 */
function buildFace3Storage(seeded: SeedEntry[]): string {
  const root = makeRoot('face3-storage')
  for (const entry of seeded) {
    const parts = entry.id.split('/')
    const ns = parts[0] ?? 'core'
    const name = parts[1] ?? entry.package
    linkDir(join(factoryNmInRepo, entry.package), join(root, 'installed', ns, name))
  }
  // T7 面3 同源 peer-clean 树：普通依赖真目录 + 链接形核心包（junction→宿主 nm 真目录）
  const hostCordis = join(root, 'host-nm', '@deepseek-ai', 'cordis')
  pkgJson(hostCordis, '@deepseek-ai/cordis', '0.1.0')
  const omni = join(root, 'installed', 'zdsh', 'omnivision')
  pkgJson(omni, '@zdsh/omnivision', '0.1.0')
  write(join(omni, 'node_modules', 'some-dep', 'index.js'), 'export const dep = 1\n')
  linkDir(hostCordis, join(omni, 'node_modules', '@deepseek-ai', 'cordis'))
  return root
}

/* ------------------------------------------------------------------ *
 * 面2 spawn 基建
 * ------------------------------------------------------------------ */

interface ChildRunReport {
  id: string
  allowed: boolean
  symMessages: string[]
  scans: number
  cacheHits: number
}

interface ChildSelfNameReport {
  resolved: boolean
  hasLoadGuard?: boolean
  hasImplementation?: boolean
  mode?: string
  run?: ChildRunReport
  error?: string
}

interface Face2Report {
  leg: string
  node: string
  cwd: string
  dshHome: string | null
  dshBranchHome: string | null
  results: ChildRunReport[]
  selfName?: ChildSelfNameReport
}

/* ------------------------------------------------------------------ *
 * A-1.2.1 双副本 fixture → CheckFailed + detail 路径清单
 * ------------------------------------------------------------------ */

describe('SymbolIsolationCheck A-1.2.1: dual-copy fixture => CheckFailed with queryable path detail', () => {
  it('flags profile dual physical copies and fake .pnpm dual instances (criterion 1)', async () => {
    const root = buildRedDual()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    const result = await new LoadGuard().preLoad(pluginFor('@demo/trojan'), '0.2.0-rc.2')
    expect(result.allowed).toBe(false)
    const messages = symFailures(result)
    expect(messages).toHaveLength(1)
    const detail = messages[0] ?? ''
    expect(result.failures[0]?.severity ?? symFailures(result)).toBe('error')
    // 面 A：profile 双物理副本（官方 rc.7 + web rc.6），detail 含两实例真实路径（路径清单可查询）
    expect(detail).toContain('[判据1·双副本候选]')
    expect(detail).toContain('@deepseek-ai/dsh-tools')
    expect(detail).toContain(realpathSync(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools')))
    expect(detail).toContain(realpathSync(join(root, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools')))
    // 假 .pnpm 双实例（卡面 A-1.2.1 字样）：同包名两 store 条目真实实例
    expect(detail).toContain('@deepseek-ai/cosmokit')
    expect(detail).toContain(realpathSync(join(root, 'node_modules', '.pnpm', '@deepseek-ai+cosmokit@0.1.0', 'node_modules', '@deepseek-ai', 'cosmokit')))
    expect(detail).toContain(realpathSync(join(root, 'node_modules', '.pnpm', '@deepseek-ai+cosmokit@0.2.0', 'node_modules', '@deepseek-ai', 'cosmokit')))
    // K-1.2.2：修复引导文案（dsh-guard CLI + safe-change 备份规程），修复动作不进内核
    expect(detail).toContain('dsh-guard.mjs check')
    expect(detail).toContain('dsh-guard.mjs fix')
    expect(detail).toContain('safe-change')
  }, 60_000)

  it('flags storage-area real copies in both trojan trees (criterion 3, sandbox-b0 draft homologous)', async () => {
    const root = buildRedDual()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    const result = await new LoadGuard().preLoad(pluginFor('@demo/trojan'), '0.2.0-rc.2')
    const detail = (symFailures(result)[0] ?? '')
    expect(detail).toContain('[判据3·存储区真实副本]')
    expect(detail).toContain(join(root, 'zdsh', 'installed', 'demo', 'trojan', 'node_modules', '@deepseek-ai', 'dsh-client-store'))
    expect(detail).toContain(join(root, 'zdsh', 'installed', 'demo', 'trojan2', 'node_modules', '@deepseek-ai', 'dsh-client-store'))
  }, 60_000)

  it('does not cache fail results (red line never sticks): second PreLoad rescans', async () => {
    const root = buildRedDual()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    const guard = new LoadGuard()
    const first = await guard.preLoad(pluginFor('@demo/trojan'), '0.2.0-rc.2')
    const mid = getSymbolIsolationScanStats()
    const second = await guard.preLoad(pluginFor('@demo/trojan'), '0.2.0-rc.2')
    const after = getSymbolIsolationScanStats()
    expect(first.allowed).toBe(false)
    expect(second.allowed).toBe(false)
    expect(after.scans - mid.scans).toBe(1)
    expect(after.cacheHits - mid.cacheHits).toBe(0)
  }, 60_000)
})

describe('SymbolIsolationCheck criterion 2: embedded core symbols in bundle artifacts', () => {
  it('flags factory artifact E1 inline trace + E2 cordis key fingerprint, and storage-installed artifact via @-prefixed id', async () => {
    const root = buildRedEmbed()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    const result = await new LoadGuard().preLoad(pluginFor('@demo/trojan'), '0.2.0-rc.2')
    expect(result.allowed).toBe(false)
    const detail = (symFailures(result)[0] ?? '')
    expect(detail).toContain('[判据2·内嵌核心符号]')
    // factory 工件 E1（内联源路径痕迹）
    expect(detail).toContain(join(root, 'packages', 'zdsh', 'factory-bundle', 'node_modules', 'dsh-evil', 'dist', 'bundle.js'))
    expect(detail).toContain('E1')
    // factory 工件 E2（注册键指纹×3，键名可查询）
    expect(detail).toContain(join(root, 'packages', 'zdsh', 'factory-bundle', 'node_modules', 'dsh-evil', 'lib', 'copy.js'))
    expect(detail).toContain('E2')
    expect(detail).toContain('cordis.evilA')
    expect(detail).toContain('cordis.evilC')
    // 存储区 installed 工件腿（@ 前缀 id → installed/demo/trojan 两级权威布局）
    expect(detail).toContain(join(root, 'zdsh', 'installed', 'demo', 'trojan', 'dist', 'bundle.js'))
    // 判据3 不连带（trojan 树无 node_modules/@assistant-ai 真实副本）
    expect(detail).not.toContain('[判据3')
  }, 60_000)
})

/* ------------------------------------------------------------------ *
 * 零误杀绿面（语义保真 + 防御分支全覆盖）
 * ------------------------------------------------------------------ */

describe('SymbolIsolationCheck zero-false-kill green faces', () => {
  it('kitchen-sink: junction single-target multi-view, BROKEN link, file-target link, stray files, single-instance store entry, backup area, sentinel layouts => CheckPassed', async () => {
    const root = buildKitchenSink()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    const before = getSymbolIsolationScanStats()
    const result = await new LoadGuard().preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    const after = getSymbolIsolationScanStats()
    expect(result.failures).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.allowed).toBe(true)
    expect(after.scans - before.scans).toBe(1)
  }, 60_000)

  it('sentinel ids: missing id / no-slash / multi-slash => criterion-2 installed leg safely skipped, no false kill', async () => {
    const root = makeRoot('sentinel')
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', join(root, 'absent-storage'))
    const guard = new LoadGuard()

    // id 缺失（非 string）：manifest-integrity 拒载，但 symbol-isolation 照常运行且不误报
    const idlessManifest = { ...testManifest(), id: undefined as unknown as string }
    const missing = await guard.preLoad({ manifest: idlessManifest, install(): void {} }, '0.2.0-rc.2')
    expect(missing.allowed).toBe(false)
    expect(symFailures(missing)).toEqual([])

    for (const id of ['noslash', 'a/b/c']) {
      resetSymbolIsolationCacheForTest()
      const before = getSymbolIsolationScanStats()
      const result = await guard.preLoad(pluginFor(id), '0.2.0-rc.2')
      const after = getSymbolIsolationScanStats()
      expect(result.failures, id).toEqual([])
      expect(result.allowed, id).toBe(true)
      expect(after.scans - before.scans, `${id} 须真扫描`).toBe(1)
    }
  }, 60_000)

  it('empty host + absent storage => every scan face skips as normal (mtime-0 key)', async () => {
    const root = makeRoot('empty')
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', join(root, 'absent-storage'))
    const result = await new LoadGuard().preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    expect(result.failures).toEqual([])
    expect(result.allowed).toBe(true)
  }, 60_000)

  it('blank DSH_HOME falls back to cwd host semantics (real repo tree, zero false kill)', async () => {
    vi.stubEnv('DSH_HOME', '')
    vi.stubEnv('DSH_BRANCH_HOME', join(makeRoot('blank-storage'), 'absent'))
    const result = await new LoadGuard().preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    expect(result.allowed).toBe(true)
  }, 120_000)
})

/* ------------------------------------------------------------------ *
 * A-1.2.3 异常注入 → fail-closed
 * ------------------------------------------------------------------ */

describe('SymbolIsolationCheck A-1.2.3: injected scan failure => fail-closed CheckFailed', () => {
  it('Error payload => CheckFailed (never CheckPassed, never escaping throw)', async () => {
    const root = buildFailClosedHost()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    fsInject.marker = root
    fsInject.payload = () => new Error('g1-injected-fs-failure')
    fsInject.active = true
    const result = await new LoadGuard().preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    fsInject.active = false
    expect(result.allowed).toBe(false)
    const detail = (symFailures(result)[0] ?? '')
    expect(detail).toContain('检查自身异常')
    expect(detail).toContain('g1-injected-fs-failure')
    expect(result.failures[0]?.severity ?? 'missing').toBe('error')
  }, 60_000)

  it('raw string payload => String(error) face => CheckFailed', async () => {
    const root = buildFailClosedHost()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    fsInject.marker = root
    fsInject.payload = () => 'G1-RAW-STRING-THROW'
    fsInject.active = true
    const result = await new LoadGuard().preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    fsInject.active = false
    expect(result.allowed).toBe(false)
    expect(symFailures(result)[0] ?? '').toContain('G1-RAW-STRING-THROW')
  }, 60_000)

  it('recovers to cached pass once injection is lifted (fail was not cached)', async () => {
    const root = buildFailClosedHost()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    const guard = new LoadGuard()
    fsInject.marker = root
    fsInject.payload = () => new Error('g1-transient')
    fsInject.active = true
    const failed = await guard.preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    fsInject.active = false
    resetSymbolIsolationCacheForTest()
    const before = getSymbolIsolationScanStats()
    const recovered = await guard.preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    const after = getSymbolIsolationScanStats()
    expect(failed.allowed).toBe(false)
    expect(recovered.allowed).toBe(true)
    expect(after.scans - before.scans).toBe(1)
    expect(after.cacheHits - before.cacheHits).toBe(0)
  }, 60_000)
})

/* ------------------------------------------------------------------ *
 * A-1.2.2 三解析面 × K-1.2.1 出厂集八件零误杀硬门
 * ------------------------------------------------------------------ */

describe('SymbolIsolationCheck A-1.2.2 x K-1.2.1: three resolution faces, factory eight zero false kill', () => {
  it('face 1 (in-tree vitest runtime): real repo tree, no DSH_HOME (cwd host), every seeded plugin truly scanned green', async () => {
    expect(process.cwd(), '面1 hostRoot=cwd 语义前提：vitest worker cwd 须为仓库根').toBe(repoRoot)
    vi.stubEnv('DSH_HOME', undefined) // 无 DSH_HOME → defaultHostRoot=cwd（树内宿主形）
    vi.stubEnv('DSH_BRANCH_HOME', join(makeRoot('face1-storage'), 'absent'))
    const seeded = readSeedEntries()
    expect(seeded.length, '出厂集 O3 后谱=八件（seed.json 真相源）').toBeGreaterThanOrEqual(8)
    const guard = new LoadGuard()
    for (const entry of seeded) {
      resetSymbolIsolationCacheForTest()
      const before = getSymbolIsolationScanStats()
      const result = await guard.preLoad(pluginFor(entry.id), '0.2.0-rc.2')
      const after = getSymbolIsolationScanStats()
      expect(result.failures, `${entry.id}: ${JSON.stringify(result.failures)}`).toEqual([])
      expect(result.allowed, entry.id).toBe(true)
      expect(after.scans - before.scans, `${entry.id} 须真扫描（非缓存空绿）`).toBe(1)
    }
  }, 240_000)

  it('face 2 (release-installed node runtime): tsx isolated cwd, four legs (release-fixture green / repo-tree eight green / dual-red control / self-name resolution R3-13)', async () => {
    const childCwd = makeRoot('face2-cwd')
    const emptyTsconfig = join(childCwd, 'tsconfig.json')
    write(emptyTsconfig, '{}\n')
    const absentStorage = join(makeRoot('face2-storage'), 'absent')
    const seeded = readSeedEntries()
    const seededIds = seeded.map(e => e.id)

    function spawnLeg(leg: string, ids: string[], dshHome: string | undefined, dshBranchHome: string): Face2Report {
      const childEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) childEnv[key] = value
      }
      delete childEnv.NODE_OPTIONS // vitest worker 注入的 loader 钩不得污染裸 node 面
      delete childEnv.TSX_TSCONFIG_PATH
      delete childEnv.DSH_HOME
      if (dshHome !== undefined) childEnv.DSH_HOME = dshHome
      childEnv.DSH_BRANCH_HOME = dshBranchHome
      childEnv.NODE_PATH = '' // 无 NODE_PATH 门面=发布安装 node 运行时解析语义
      const spawned = spawnSync(
        process.execPath,
        [tsxCli, '--tsconfig', emptyTsconfig, helperPath, leg, JSON.stringify({ ids })],
        { cwd: childCwd, encoding: 'utf8', timeout: 240_000, maxBuffer: 32 * 1024 * 1024, env: childEnv },
      )
      expect(spawned.status, `面2 ${leg} 腿退出码非0: stderr=${(spawned.stderr ?? '').slice(0, 1500)}`).toBe(0)
      const reportLine = (spawned.stdout ?? '').split('\n').filter(l => l.startsWith('G1-FACE2-REPORT ')).at(-1)
      expect(reportLine, `面2 ${leg} 腿无报告行: stdout=${(spawned.stdout ?? '').slice(0, 800)}`).toBeDefined()
      return JSON.parse((reportLine ?? '').slice('G1-FACE2-REPORT '.length)) as Face2Report
    }

    // 腿 a：发布安装 profile 仿形（T7 面2 同源）全绿
    const releaseRoot = buildReleaseProfile()
    const release = spawnLeg('release-fixture', seededIds, releaseRoot, absentStorage)
    expect(release.results).toHaveLength(seededIds.length)
    for (const run of release.results) {
      expect(run.symMessages, `${run.id}: ${run.symMessages.join('|')}`).toEqual([])
      expect(run.allowed, run.id).toBe(true)
      expect(run.scans, `${run.id} 须真扫描`).toBe(1)
    }

    // 腿 b：真实仓库宿主树（K-1.2.1 面2腿：出厂八件在裸 node 解析面各真扫描全绿）
    const repoTree = spawnLeg('repo-tree', seededIds, repoRoot, absentStorage)
    for (const run of repoTree.results) {
      expect(run.symMessages, `${run.id}: ${run.symMessages.join('|')}`).toEqual([])
      expect(run.allowed, run.id).toBe(true)
      expect(run.scans, `${run.id} 须真扫描`).toBe(1)
    }

    // 腿 c：双副本红对照（面2检查活体证明——非空绿）
    const dualRoot = buildRedDual()
    const dual = spawnLeg('dual-red', ['@demo/trojan'], dualRoot, absentStorage)
    expect(dual.results).toHaveLength(1)
    expect(dual.results[0]?.allowed).toBe(false)
    expect(dual.results[0]?.symMessages[0] ?? '').toContain('[判据1·双副本候选]')

    // 腿 d：裸自名 import 解析面实测（R3-13 销项核心）
    const selfName = spawnLeg('self-name', [seededIds[0] ?? 'core/webstack'], repoRoot, absentStorage)
    const sn = selfName.selfName
    expect(sn, '自名腿报告缺失').toBeDefined()
    if (!existsSync(libEntry)) {
      // lib 构建产物缺席：exports '.' 指向缺失文件 → 解析必然失败=诚实跳过面（非 R3-13 红信号；
      // 发布安装件必携 lib=构建产物，本腿语义在有构建的机器上成立，回执记录本态）
      expect(sn?.resolved).toBe(false)
    } else {
      expect(sn?.resolved, `R3-13 翻转坐实：lib 在位而裸自名解析失败: ${sn?.error ?? ''}`).toBe(true)
      const libIsFresh = readFileSync(libEntry, 'utf8').includes('getSymbolIsolationScanStats')
      if (libIsFresh) {
        expect(sn?.mode).toBe('green')
        expect(sn?.run?.symMessages ?? ['missing-run']).toEqual([])
        expect(sn?.run?.allowed).toBe(true)
        expect(sn?.run?.scans).toBe(1)
      } else {
        // 解析面已证成立（R3-13 核心问题=能否解析）；实现面=构建滞后（typecheck/build:lib 重跑即 green 实证）
        expect(sn?.mode).toBe('stale-lib')
      }
    }
  }, 300_000)

  it('face 3 (governance storage install): eight junction artifacts + T7-face-3 homologous peer-clean tree, all green', async () => {
    const seeded = readSeedEntries()
    const storageRoot = buildFace3Storage(seeded)
    vi.stubEnv('DSH_HOME', repoRoot)
    vi.stubEnv('DSH_BRANCH_HOME', storageRoot)
    const guard = new LoadGuard()
    for (const entry of seeded) {
      resetSymbolIsolationCacheForTest()
      const before = getSymbolIsolationScanStats()
      const result = await guard.preLoad(pluginFor(entry.id), '0.2.0-rc.2')
      const after = getSymbolIsolationScanStats()
      expect(result.failures, `${entry.id}: ${JSON.stringify(result.failures)}`).toEqual([])
      expect(result.allowed, entry.id).toBe(true)
      expect(after.scans - before.scans, `${entry.id} 须真扫描（判据2 installed 腿经 junction 实扫工件）`).toBe(1)
    }
    // 清场安全性自检：junction 清理不跟随——真工件目标树必须在位
    for (const entry of seeded) {
      expect(existsSync(join(factoryNmInRepo, entry.package, 'package.json')), `面3 清理误伤目标树: ${entry.package}`).toBe(true)
    }
  }, 240_000)
})

/* ------------------------------------------------------------------ *
 * 验收-7 性能断言：二次 PreLoad 零重复扫盘
 * ------------------------------------------------------------------ */

describe('SymbolIsolationCheck acceptance-7: (hostRoot,mtime) pass cache, no repeated disk scans', () => {
  it('second and third PreLoad hit the pass cache (cross-plugin, zero rescans)', async () => {
    const root = buildKitchenSink()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    const guard = new LoadGuard()
    resetSymbolIsolationCacheForTest()
    const base = getSymbolIsolationScanStats()

    const first = await guard.preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    const afterFirst = getSymbolIsolationScanStats()
    expect(first.allowed).toBe(true)
    expect(afterFirst.scans - base.scans).toBe(1)
    expect(afterFirst.cacheHits - base.cacheHits).toBe(0)

    const second = await guard.preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    const afterSecond = getSymbolIsolationScanStats()
    expect(second.allowed).toBe(true)
    expect(afterSecond.scans - base.scans, '二次 PreLoad 零重复扫盘').toBe(1)
    expect(afterSecond.cacheHits - base.cacheHits).toBe(1)

    // 跨插件同键命中（卡面：PreLoad 每插件不重复扫盘）
    const third = await guard.preLoad(pluginFor('other/plugin'), '0.2.0-rc.2')
    const afterThird = getSymbolIsolationScanStats()
    expect(third.allowed).toBe(true)
    expect(afterThird.scans - base.scans).toBe(1)
    expect(afterThird.cacheHits - base.cacheHits).toBe(2)
  }, 60_000)
})

/* ------------------------------------------------------------------ *
 * FB2 缓存双腿加固（TC-B4-H1 面一，D1b §3-FB2 加固建议①③；定级口径
 * 原文维持 [建议]：加固≠消除，对抗位阶论证不变，签名加固维持不做）
 * ------------------------------------------------------------------ */

describe('SymbolIsolationCheck FB2 hardening: ns 粒度失效腿 + 代数上限腿', () => {
  it('幕 b 同形：既有 ns 下植入真实副本经 ns mtime 腿失效 pass 缓存，重扫必检出（判据3）', async () => {
    const root = buildKitchenSink()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    const guard = new LoadGuard()
    const first = await guard.preLoad(pluginFor('demo/clean-plugin'), '0.2.0-rc.2')
    expect(first.allowed).toBe(true)
    const mid = getSymbolIsolationScanStats()
    // D1b 幕 b 同形植入：既有 ns（demo）下新增插件目录+FAKE_STORE_PKG 同形真实
    // 副本。installed/ 顶层 mtime 不动=旧键面（顶层三根）失明、恒 cacheHits 过；
    // ns 粒度腿在位后 demo 目录 mtime 变→键失效→真重扫。
    const fake = join(root, 'zdsh', 'installed', 'demo', 'b-plugin', 'node_modules', '@deepseek-ai', 'dsh-client-store')
    pkgJson(fake, '@deepseek-ai/dsh-client-store', '9.9.9-fake-tc-b0')
    write(join(fake, 'index.js'), "export const marker = 'FAKE'\n")
    const second = await guard.preLoad(pluginFor('demo/b-plugin'), '0.2.0-rc.2')
    const after = getSymbolIsolationScanStats()
    // 判别锁（旧形复刻必红：旧键面此处 cacheHits+1 且 allowed=true）：
    // ns 腿保证真重扫，且重扫必检出存储区副本。
    expect(after.scans - mid.scans).toBe(1)
    expect(after.cacheHits - mid.cacheHits).toBe(0)
    expect(second.allowed).toBe(false)
    expect(symFailures(second)[0] ?? '').toContain('[判据3·存储区真实副本]')
  }, 60_000)

  it('代数上限：PASS_CACHE_MAX_HITS(64) 代命中满后下次 PreLoad 强制真重扫（清洁树仍绿）', async () => {
    const root = buildKitchenSink()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('DSH_BRANCH_HOME', '')
    const guard = new LoadGuard()
    const base = getSymbolIsolationScanStats()
    expect((await guard.preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')).allowed).toBe(true)
    for (let generation = 0; generation < 64; generation += 1) {
      await guard.preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    }
    const mid = getSymbolIsolationScanStats()
    // 64 代全命中零重扫（性能契约保持：acceptance-7 语义不变）。
    expect(mid.scans - base.scans).toBe(1)
    expect(mid.cacheHits - base.cacheHits).toBe(64)
    // 第 65 次：代数上限满→删键强制真重扫（对抗性 mtime 伪造的恒过窗压缩为
    // ≤64 代；清洁树重扫结果不变=仍绿，红线不粘滞语义零触碰）。
    const forced = await guard.preLoad(pluginFor('test/plugin'), '0.2.0-rc.2')
    const after = getSymbolIsolationScanStats()
    expect(forced.allowed).toBe(true)
    expect(after.scans - mid.scans).toBe(1)
    expect(after.cacheHits - mid.cacheHits).toBe(0)
  }, 120_000)
})
