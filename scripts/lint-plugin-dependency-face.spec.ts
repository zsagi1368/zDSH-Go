import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyHostSpecifier,
  collectImportSites,
  isSrcPath,
  loadDependencyFaceConfig,
  resolveScanTargets,
  scanRepository,
  splitPackageSpecifier,
  type DependencyFaceConfig,
} from './lint-plugin-dependency-face.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-dep-face-'))
  roots.push(root)
  return root
}

const CONFIG: DependencyFaceConfig = {
  hostOrgPrefix: '@deepseek-ai/',
  pluginsRoot: join(tmpdir(), 'unused-plugins-root'),
  defaultTargets: [
    { name: 'FakePlugin', dir: 'FakePlugin' },
    { name: 'OtherPlugin', dir: 'OtherPlugin' },
  ],
  contractFace: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-client-ui-settings'],
  internalFace: ['@deepseek-ai/dsh-compat', '@deepseek-ai/dsh-app-boot'],
  exemptions: [
    { repo: 'FakePlugin', specifierPrefix: '@deepseek-ai/dsh-legacy-', reason: 'recorded legacy debt' },
  ],
}

describe('splitPackageSpecifier', () => {
  it('splits scoped names from their subpaths', () => {
    expect(splitPackageSpecifier('@deepseek-ai/dsh-tools')).toEqual({ packageName: '@deepseek-ai/dsh-tools', subpath: '' })
    expect(splitPackageSpecifier('@deepseek-ai/dsh-client-ui-settings/client')).toEqual({
      packageName: '@deepseek-ai/dsh-client-ui-settings',
      subpath: '/client',
    })
    expect(splitPackageSpecifier('cordis')).toEqual({ packageName: 'cordis', subpath: '' })
  })
})

describe('classifyHostSpecifier', () => {
  it('ignores non-host-org specifiers', () => {
    expect(classifyHostSpecifier('node:fs', CONFIG)).toBeNull()
    expect(classifyHostSpecifier('react', CONFIG)).toBeNull()
    expect(classifyHostSpecifier('./relative', CONFIG)).toBeNull()
  })

  it('accepts contract-face bare names and declared export subpaths', () => {
    expect(classifyHostSpecifier('@deepseek-ai/cordis', CONFIG)).toBeNull()
    expect(classifyHostSpecifier('@deepseek-ai/dsh-tools', CONFIG)).toBeNull()
    expect(classifyHostSpecifier('@deepseek-ai/dsh-client-ui-settings/client', CONFIG)).toBeNull()
  })

  it('flags deep-path reaches into src, internal, build-output dirs, and direct source files', () => {
    for (const specifier of [
      '@deepseek-ai/dsh-tools/src/index.ts',
      '@deepseek-ai/dsh-tools/src/schema',
      '@deepseek-ai/dsh-client-ui-settings/internal/registry',
      '@deepseek-ai/dsh-tools/lib/index.js',
      '@deepseek-ai/cordis/dist/cordis.mjs',
      // REVIEW-T5 建议4: non-JS assets under build-output dirs slipped past
      // the extension criterion; the dist/lib segment rule closes that gap.
      '@deepseek-ai/dsh-tools/dist/theme.css',
      '@deepseek-ai/dsh-tools/lib/style.css',
      '@deepseek-ai/cordis/dist',
    ]) {
      expect(classifyHostSpecifier(specifier, CONFIG)?.kind, specifier).toBe('deep-path')
    }
  })

  it('flags internal-face packages even without a subpath', () => {
    expect(classifyHostSpecifier('@deepseek-ai/dsh-compat', CONFIG)).toEqual({
      kind: 'internal-face',
      reason: '@deepseek-ai/dsh-compat is host-internal wiring, not plugin-facing',
    })
  })

  it('flags host-org packages outside the contract face', () => {
    expect(classifyHostSpecifier('@deepseek-ai/dsh-app-boot/src/boot', CONFIG)?.kind).toBe('deep-path')
    expect(classifyHostSpecifier('@deepseek-ai/dsh-session', CONFIG)).toEqual({
      kind: 'non-contract-face',
      reason: '@deepseek-ai/dsh-session is not on the contract face',
    })
  })
})

describe('collectImportSites', () => {
  it('collects static, re-export, dynamic, and require specifiers with lines', () => {
    const text = [
      "import { defineTool } from '@deepseek-ai/dsh-tools'",
      "import type { Ctx } from '@deepseek-ai/cordis'",
      "export { x } from '@deepseek-ai/dsh-client-store/src/x'",
      "const mod = await import('@deepseek-ai/dsh-web')",
      "const legacy = require('@deepseek-ai/dsh-legacy-a')",
      "const local = './not-host'",
      '',
    ].join('\n')
    const sites = collectImportSites(text, 'index.ts')
    expect(sites.map(site => site.specifier)).toEqual([
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store/src/x',
      '@deepseek-ai/dsh-web',
      '@deepseek-ai/dsh-legacy-a',
    ])
    expect(sites[0]?.line).toBe(1)
    expect(sites[3]?.line).toBe(4)
  })

  it('ignores commented-out and string-literal lookalikes', () => {
    const text = [
      "// import { x } from '@deepseek-ai/dsh-tools'",
      "const note = \"from '@deepseek-ai/dsh-compat'\"",
      '',
    ].join('\n')
    expect(collectImportSites(text, 'index.ts')).toEqual([])
  })
})

describe('isSrcPath', () => {
  it('matches files under any src directory only', () => {
    expect(isSrcPath('src/index.ts')).toBe(true)
    expect(isSrcPath('packages/webstack/src/tools/a.ts')).toBe(true)
    expect(isSrcPath('tests/helper.ts')).toBe(false)
    expect(isSrcPath('srcless/file.ts')).toBe(false)
  })
})

describe('scanRepository', () => {
  function writeFixture(repoRoot: string, relativePath: string, content: string): void {
    const absolute = join(repoRoot, relativePath)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }

  it('reports violations with file:line, keeps contract-face quiet, and honors exemptions', () => {
    const root = fixtureRoot()
    writeFixture(root, 'src/index.ts', [
      "import { defineTool } from '@deepseek-ai/dsh-tools'",
      "import { guardFeature } from '@deepseek-ai/dsh-compat'",
      "import { boot } from '@deepseek-ai/dsh-app-boot/src/index'",
      '',
    ].join('\n'))
    writeFixture(root, 'src/legacy.ts', "import { old } from '@deepseek-ai/dsh-legacy-shim'\n")
    // Outside src: never scanned.
    writeFixture(root, 'tests/tool.ts', "import { x } from '@deepseek-ai/dsh-session'\n")
    // Pruned directories: never scanned (node_modules and the del backup area).
    writeFixture(root, 'node_modules/dep/src/index.ts', "import { x } from '@deepseek-ai/dsh-session'\n")
    writeFixture(root, 'del/20260101-000000-old/src/index.ts', "import { x } from '@deepseek-ai/dsh-compat'\n")

    const report = scanRepository('FakePlugin', root, CONFIG)
    expect(report.scannedFiles).toBe(2)
    expect(report.hostImportSites).toBe(4)
    expect(report.violations).toEqual([
      {
        repo: 'FakePlugin',
        file: 'src/index.ts',
        line: 2,
        specifier: '@deepseek-ai/dsh-compat',
        kind: 'internal-face',
        reason: '@deepseek-ai/dsh-compat is host-internal wiring, not plugin-facing',
      },
      {
        repo: 'FakePlugin',
        file: 'src/index.ts',
        line: 3,
        specifier: '@deepseek-ai/dsh-app-boot/src/index',
        kind: 'deep-path',
        // zDSH: vitest 官方类型缺陷 `stringContaining: (expected: string) => any`
        // （@vitest/expect d.ts）触发 no-unsafe-assignment；as string 仅编译期收窄，
        // 运行时仍是同一 asymmetric matcher，断言语义零改动。
        reason: expect.stringContaining('reaches past the published export surface') as string,
      },
    ])
    expect(report.exempted.map(entry => entry.violation.specifier)).toEqual(['@deepseek-ai/dsh-legacy-shim'])
    expect(report.exempted[0]?.reason).toBe('recorded legacy debt')
  })

  it('throws loudly when the scan target is missing', () => {
    const root = fixtureRoot()
    expect(() => scanRepository('Ghost', join(root, 'missing'), CONFIG)).toThrow()
  })
})

describe('loadDependencyFaceConfig', () => {
  it('loads and cross-checks the shipped manifest', () => {
    const config = loadDependencyFaceConfig(join(import.meta.dirname, 'plugin-dependency-face.manifest.json'))
    expect(config.hostOrgPrefix).toBe('@deepseek-ai/')
    // REVIEW-T5 建议3: the shipped default is RELATIVE (repo-root anchored),
    // never a machine-specific absolute path; pinned here against regressions.
    expect(config.pluginsRoot).toBe('../zDSH-plugins')
    expect(config.contractFace).toContain('@deepseek-ai/cordis')
    expect(config.internalFace).toContain('@deepseek-ai/dsh-compat')
    // The six true-source repos carry the eight seeded artifacts.
    expect(config.defaultTargets.map(target => target.name)).toEqual([
      'WebStack', 'Omnivision', 'FileHub', 'PluginCenter', 'AutoPilot', 'Workbench',
    ])
    expect(config.exemptions.map(entry => entry.repo)).toEqual(['ContextManagement'])
  })

  it('rejects a manifest whose faces overlap', () => {
    const root = fixtureRoot()
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({
      hostOrgPrefix: '@deepseek-ai/',
      pluginsRoot: root,
      defaultTargets: [],
      contractFace: ['@deepseek-ai/dsh-compat'],
      internalFace: ['@deepseek-ai/dsh-compat'],
      exemptions: [],
    }))
    expect(() => loadDependencyFaceConfig(manifestPath)).toThrow(/overlap/)
  })

  it('rejects malformed manifests loudly', () => {
    const root = fixtureRoot()
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(manifestPath, '{"hostOrgPrefix": ""}')
    expect(() => loadDependencyFaceConfig(manifestPath)).toThrow(/hostOrgPrefix/)
  })
})

describe('resolveScanTargets', () => {
  it('resolves manifest defaults against the plugins root', () => {
    const targets = resolveScanTargets({ config: CONFIG, cliTargets: [], pluginsRoot: '/plugins' })
    expect(targets).toEqual([
      { name: 'FakePlugin', root: resolve('/plugins', 'FakePlugin') },
      { name: 'OtherPlugin', root: resolve('/plugins', 'OtherPlugin') },
    ])
  })

  it('accepts named targets and absolute paths from the CLI', () => {
    const byName = resolveScanTargets({ config: CONFIG, cliTargets: ['FakePlugin'], pluginsRoot: '/plugins' })
    expect(byName).toEqual([{ name: 'FakePlugin', root: resolve('/plugins', 'FakePlugin') }])
    const byPath = resolveScanTargets({ config: CONFIG, cliTargets: ['/elsewhere/repo'], pluginsRoot: '/plugins' })
    expect(byPath).toEqual([{ name: '/elsewhere/repo', root: resolve('/elsewhere/repo') }])
  })

  it('anchors a relative manifest pluginsRoot at the repository root (portability)', () => {
    const config: DependencyFaceConfig = { ...CONFIG, pluginsRoot: '../sibling-plugins' }
    const repoRoot = resolve(import.meta.dirname, '..')
    expect(resolveScanTargets({ config, cliTargets: [], pluginsRoot: null })).toEqual([
      { name: 'FakePlugin', root: resolve(repoRoot, '..', 'sibling-plugins', 'FakePlugin') },
      { name: 'OtherPlugin', root: resolve(repoRoot, '..', 'sibling-plugins', 'OtherPlugin') },
    ])
  })

  it('passes an absolute manifest pluginsRoot through unchanged', () => {
    const absolute = join(tmpdir(), 'absolute-plugins-root')
    const config: DependencyFaceConfig = { ...CONFIG, pluginsRoot: absolute }
    expect(resolveScanTargets({ config, cliTargets: [], pluginsRoot: null })).toEqual([
      { name: 'FakePlugin', root: resolve(absolute, 'FakePlugin') },
      { name: 'OtherPlugin', root: resolve(absolute, 'OtherPlugin') },
    ])
  })
})
