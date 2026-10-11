/**
 * F7 path-containment guards (TC-B4-H1 face 6; D1a F7 + D1b §4): the seed
 * file is an UNTRUSTED declarative document — these locks pin the second
 * deny-by-default door on path semantics.
 *
 * 判别锁谱（卡面锁纪律三雷必锁）：
 * - startsWith 碰撞雷：`<root>-evil` 前缀碰撞形必拒（relative 形天然免疫）；
 * - 跨盘符雷：win32 跨盘必拒（isAbsolute(rel) 腿；win32 分支断言）；
 * - junction 雷：链接本体在根内而 realpath 逃逸根外必拒（realpathSync.native
 *   双侧同坐标系腿）；
 * - 等根拒/`..` 段拒/`..foo` 合法名放行（分段精确比较非前缀）。
 * 正对照（K-1.2.1 同款零误杀纪律）：仓内相对行原值返回（与前门形零漂移）、
 * 仓内 pnpm junction 形放行、**真 seed 七行现状逐行必过**（真树只读）。
 * factory 段校验（D1b §4.1 第三位）：绝对值/`..` 段/等根必拒、合法相对放行。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { isStrictlyInside, resolveContainedPath, resolveFactoryModulePath } from '../src/path-containment.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const SEED_PATH = join(REPO_ROOT, 'zdsh-factory', 'seed.json')

const roots: string[] = []

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `f7-containment-${tag}-`))
  roots.push(root)
  return root
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

describe('isStrictlyInside: segment-precise containment (patterns trap trio)', () => {
  it('accepts a strict descendant and rejects the equal root', () => {
    const root = makeRoot('basic')
    expect(isStrictlyInside(root, join(root, 'a', 'b'))).toBe(true)
    // 拒等根（filehub 等价形原文腿）。
    expect(isStrictlyInside(root, root)).toBe(false)
  })

  it('rejects any ".." segment while allowing ".."-prefixed legal names', () => {
    const root = makeRoot('dotdot')
    // 逃逸父级=relative 产出 `..` 段必拒（中段 '..' 被 join/resolve 先行规范化
    // 消除，永不残存到分段比较——本腿锁 relative 输出侧的 '..' 判定）。
    expect(isStrictlyInside(root, join(root, '..', 'outside'))).toBe(false)
    expect(isStrictlyInside(root, join(root, '..'))).toBe(false)
    // 分段精确比较（非 startsWith 前缀）：'..foo' 是合法目录名。
    expect(isStrictlyInside(root, join(root, '..foo'))).toBe(true)
  })

  it('rejects the startsWith prefix-collision sibling (collision mine)', () => {
    const root = makeRoot('collide')
    const evil = `${root}-evil`
    mkdirSync(join(evil, 'x'), { recursive: true })
    roots.push(evil)
    // 朴素 startsWith(root) 会误放 <root>-evil\x —— relative 形必拒。
    expect(isStrictlyInside(root, join(evil, 'x'))).toBe(false)
  })

  it('rejects cross-drive candidates on win32 (cross-drive mine)', () => {
    if (process.platform !== 'win32') return // 跨盘符为 win32 语义面；POSIX 由 `..` 段腿承载
    expect(isStrictlyInside('C:\\a-repo', 'D:\\elsewhere\\pkg')).toBe(false)
    expect(isStrictlyInside('C:\\a-repo', 'C:\\a-repo\\pkg')).toBe(true)
  })
})

describe('resolveContainedPath: textual + link-normalized containment (F7 second door)', () => {
  it('returns the identical resolved value for a legal in-root relative row (zero drift)', () => {
    const root = makeRoot('legal')
    write(join(root, 'packages', 'artifact', 'package.json'), '{"name":"@demo/artifact"}')
    const resolved = resolveContainedPath(root, 'packages/artifact', 'local: seed source')
    expect(resolved).toBe(resolve(root, 'packages', 'artifact'))
  })

  it('rejects the equal root and accepts an absent in-root row (absence is the install face judgment)', () => {
    const root = makeRoot('absent')
    // 等根拒：seed 行必须指向根内严格后代。
    expect(() => resolveContainedPath(root, '.', 'local: seed source')).toThrow(/escapes its containment root/)
    // 根内缺席 ≠ 逃逸：缺席归 install 面既有语义判（not an existing local directory），本门放行原值。
    expect(() => resolveContainedPath(root, join(root, 'missing-pkg'), 'local: seed source')).not.toThrow()
    expect(resolveContainedPath(root, join(root, 'missing-pkg'), 'local: seed source')).toBe(join(root, 'missing-pkg'))
  })

  it('rejects a "../" escape row with a queryable reason', () => {
    const root = makeRoot('escape')
    expect(() => resolveContainedPath(root, '../escaped-plugin', 'local: seed source'))
      .toThrow(/escapes its containment root/)
  })

  it('rejects an outside-root absolute row', () => {
    const root = makeRoot('outside')
    const outside = makeRoot('outside-target')
    expect(() => resolveContainedPath(root, outside, 'local: seed source'))
      .toThrow(/escapes its containment root/)
  })

  it('rejects a junction whose body is in-root but whose target escapes (junction mine)', () => {
    const root = makeRoot('junction')
    const outside = makeRoot('junction-target')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    const link = join(root, 'node_modules', 'escaped-pkg')
    symlinkSync(outside, link, 'junction') // win32 junction；POSIX 忽略 type=普通目录 symlink，同语义
    expect(() => resolveContainedPath(root, 'node_modules/escaped-pkg', 'local: seed source'))
      .toThrow(/junction\/symlink escape/)
  })

  it('accepts an in-root pnpm-shaped junction (zero-false-kill leg) and returns the textual path', () => {
    const root = makeRoot('pnpm-shape')
    // pnpm 装件现状同形：bundle nm 条目 = junction → 仓内 .pnpm 键树。
    const storePkg = join(root, 'node_modules', '.pnpm', 'demo@1.0.0', 'node_modules', 'demo-pkg')
    write(join(storePkg, 'package.json'), '{"name":"demo-pkg","version":"1.0.0"}')
    const bundleNm = join(root, 'packages', 'factory', 'bundle', 'node_modules')
    mkdirSync(bundleNm, { recursive: true })
    symlinkSync(storePkg, join(bundleNm, 'demo-pkg'), 'junction')
    const spec = join('packages', 'factory', 'bundle', 'node_modules', 'demo-pkg')
    // 文本腿+realpath 腿双双通过（终点在根内），返回文本解析值=下游零漂移。
    expect(resolveContainedPath(root, spec, 'local: seed source')).toBe(resolve(root, spec))
  })

  it('passes every real seed local: row against the real repo root (K-1.2.1 homologous zero-false-kill)', () => {
    const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as {
      entries?: Array<{ id: string; source: string }>
    }
    const rows = (seed.entries ?? []).filter(entry => entry.source.startsWith('local:'))
    expect(rows.length, '出厂谱 local: 行非空前提（seed.json 真相源）').toBeGreaterThanOrEqual(7)
    for (const row of rows) {
      const rest = row.source.slice('local:'.length)
      // 正对照：七行现状必过且返回值与前门形逐字一致（resolve(repoRoot, rest)）。
      expect(() => resolveContainedPath(REPO_ROOT, rest, 'local: seed source'), `${row.id} 误杀`).not.toThrow()
      expect(resolveContainedPath(REPO_ROOT, rest, 'local: seed source')).toBe(resolve(REPO_ROOT, rest))
    }
  })
})

describe('resolveFactoryModulePath: artifact-declared factory segment gate (F7 third point)', () => {
  it('accepts the shipping shapes (./lib/index.js, dist/index.js)', () => {
    const sourceDir = makeRoot('factory-ok')
    expect(resolveFactoryModulePath(sourceDir, './lib/index.js')).toBe(join(sourceDir, 'lib', 'index.js'))
    expect(resolveFactoryModulePath(sourceDir, 'dist/index.js')).toBe(join(sourceDir, 'dist', 'index.js'))
  })

  it('rejects ".." segments, absolute values, and the equal root', () => {
    const sourceDir = makeRoot('factory-evil')
    expect(() => resolveFactoryModulePath(sourceDir, '../evil.js')).toThrow(/escapes the artifact source directory/)
    expect(() => resolveFactoryModulePath(sourceDir, join(tmpdir(), 'evil.js'))).toThrow(/escapes the artifact source directory/)
    expect(() => resolveFactoryModulePath(sourceDir, '.')).toThrow(/escapes the artifact source directory/)
  })
})
