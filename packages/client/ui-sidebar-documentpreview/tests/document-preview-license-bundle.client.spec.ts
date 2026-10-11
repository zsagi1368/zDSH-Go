/** Published PDF and spreadsheet chunks retain their bundled license notices. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(packageRoot, '..', '..', '..')
const healthRecipeScript = join(repositoryRoot, 'scripts', 'run-healthy-spec.mjs')
const bundlePath = join(packageRoot, 'lib/client.js')
const pdfChunkPath = join(packageRoot, 'lib/client.pdf.js')
const require = createRequire(import.meta.url)
const licenseNames = [
  'LICENSE',
  'cmaps/LICENSE',
  'standard_fonts/LICENSE_FOXIT',
  'standard_fonts/LICENSE_LIBERATION',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS',
] as const

function run(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

function runPnpm(args: string[], cwd: string, timeout: number): string {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    if (process.platform === 'win32') throw new Error('npm_execpath is required to run pnpm on Windows')
    return run('pnpm', args, cwd, timeout)
  }
  return /\.[cm]?js$/iu.test(entrypoint)
    ? run(process.execPath, [entrypoint, ...args], cwd, timeout)
    : run(entrypoint, args, cwd, timeout)
}

// zDSH (MAIN-HYGIENE, sync-017 DEBT rulings §9/B3): route the three tar spawns
// below through scripts/run-healthy-spec.mjs `detect-tar --json` — the single
// source of truth for the bsdtar probe. Its prior consumer (this package's
// pdf-license-bundle spec) was deleted upstream; this consumer text carries
// over from that spec (TC-B4-S2c/S2d lineage) behind a once-per-process cache.
// On Windows git-bash, GNU tar shadows C:\Windows\System32\tar.exe on PATH and
// misreads drive-letter archive paths as remote hosts ("tar: Cannot connect to
// C:", spawnSync status 128); the recipe adopts the absolute bsdtar path when
// present and falls back to PATH `tar` otherwise (POSIX tar handles absolute
// paths). Additive helper only — the assertions below are unchanged.
interface DetectedTar {
  kind: 'absolute' | 'command'
  path: string
}

interface TarDetectionPayload {
  ok: boolean
  tar?: { adopted?: { kind?: 'absolute' | 'command'; path?: string } | null }
}

/**
 * Resolve the tar command through the repository health-recipe script
 * (`scripts/run-healthy-spec.mjs detect-tar --json`), the single source of
 * truth for the bsdtar probe, so this spec cannot drift from the recipe it is
 * verified with. Spawned as a child process (repo precedent: the deleted
 * pdf-license-bundle spec, install-lefthook.spec.ts) to keep this file free of
 * untyped static imports.
 */
function detectTar(): DetectedTar {
  const probe = spawnSync(process.execPath, [healthRecipeScript, 'detect-tar', '--json'], {
    cwd: packageRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
  })
  // TC-B4-S2d (REVIEW-S2c suggestion 1): a corrupted recipe payload must
  // surface as structured guidance, not a bare SyntaxError from JSON.parse.
  let payload: TarDetectionPayload | undefined
  if (probe.stdout !== '') {
    try {
      payload = JSON.parse(probe.stdout) as TarDetectionPayload
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`tar detection: ${healthRecipeScript} detect-tar returned invalid JSON (${detail}): verify the recipe script is intact — stdout in --json mode must be exactly the detect-tar contract payload`)
    }
  }
  const adopted = payload?.tar?.adopted ?? undefined
  if (probe.status !== 0 || payload === undefined || !payload.ok || adopted === undefined) {
    throw new Error(`no usable tar detected via ${healthRecipeScript}: ${probe.stderr === '' ? `exit ${String(probe.status)}` : probe.stderr}`)
  }
  const { kind, path } = adopted
  if (kind !== 'absolute' && kind !== 'command') {
    throw new Error(`tar detection returned an unknown candidate kind: ${JSON.stringify(adopted)}`)
  }
  if (path === undefined || path === '') {
    throw new Error(`tar detection returned an empty path: ${JSON.stringify(adopted)}`)
  }
  return { kind, path }
}

/** Cached {@link detectTar} — one recipe spawn per process, three consumers. */
let adoptedTar: DetectedTar | undefined
function healthyTar(): DetectedTar {
  adoptedTar ??= detectTar()
  return adoptedTar
}

describe('published document preview licenses', () => {
  it.skipIf(!existsSync(bundlePath))('keeps bundled licenses in the packed lazy chunks', ({ task }) => {
    expect(existsSync(pdfChunkPath)).toBe(true)
    const output = mkdtempSync(join(tmpdir(), 'dsh-document-preview-pack-'))
    try {
      const packed = JSON.parse(runPnpm([
        'pack', '--json', '--pack-destination', output,
      ], packageRoot, task.timeout)) as { filename: string; files: { path: string }[] }
      expect(packed.files.map(file => file.path)).toContain('lib/client.js')
      expect(packed.files.map(file => file.path)).toContain('lib/client.pdf.js')
      expect(packed.files.map(file => file.path)).toContain('lib/client.frontmatter-fields.js')
      expect(packed.files.some(file => file.path.endsWith('pdfjs-NOTICES.txt'))).toBe(false)

      // zDSH (MAIN-HYGIENE, rulings §9): adopted tar (bsdtar absolute path on
      // win32, PATH tar elsewhere) — spawn command only, args/assertions unchanged.
      const tar = healthyTar()
      const client = run(tar.path, ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.js'], packageRoot, task.timeout)
      const pdf = run(tar.path, ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.pdf.js'], packageRoot, task.timeout)
      expect([...client.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual(['./client.frontmatter-fields.js', './client.pdf.js', './client.excel.js'])
      expect(client).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect([...pdf.matchAll(/require\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual([])
      expect(client).not.toContain('//! Bundled PDF.js license notices')
      expect(client).not.toContain('/pdfjs-dist/')
      expect(pdf).toContain('//! Bundled PDF.js license notices')
      const excel = run(tar.path, ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.excel.js'], packageRoot, task.timeout)
      expect(excel).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect(client).not.toContain('FortuneSheet')
      expect(excel).toContain('//! Bundled spreadsheet license notices')
      expect(excel).toContain('Copyright (c) 2022 Suzhou Ruilisi Technology Co., Ltd')
      expect(excel).toContain('Permission is hereby granted, free of charge')
      for (const dependency of ['xlsx', 'papaparse']) {
        const root = dirname(require.resolve(dependency === 'xlsx' ? dependency : `${dependency}/package.json`))
        const license = readFileSync(join(root, 'LICENSE'), 'utf8').trimEnd()
        expect(excel).toContain(license.split('\n').map(line => `// ${line}`).join('\n'))
      }
      const frontmatter = run('tar', ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.frontmatter-fields.js'], packageRoot, task.timeout)
      expect(frontmatter).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      let frontmatterInitialized = false
      runInNewContext(frontmatter, { window: { __ModuleLoader__: { load: (registration: {
        factory: (resolve: (specifier: string) => unknown) => { FrontmatterFields: unknown }
      }) => {
        const loaded = registration.factory((specifier) => {
          if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier)
          throw new Error(`Unexpected browser dependency: ${specifier}`)
        })
        expect(typeof loaded.FrontmatterFields).toBe('function')
        frontmatterInitialized = true
      } } } })
      expect(frontmatterInitialized).toBe(true)
      let initialized = false
      runInNewContext(excel, { window: { __ModuleLoader__: { load: (registration: {
        factory: (resolve: (specifier: string) => unknown) => { ExcelBody: unknown }
      }) => {
        const loaded = registration.factory((specifier) => {
          if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}
          if (specifier === 'react' || specifier === 'react/jsx-runtime' || specifier === 'react-dom') return require(specifier)
          throw new Error(`Unexpected browser dependency: ${specifier}`)
        })
        expect(typeof loaded.ExcelBody).toBe('function')
        initialized = true
      } } } })
      expect(initialized).toBe(true)
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
      for (const name of licenseNames) {
        const source = readFileSync(join(pdfRoot, name), 'utf8').trimEnd()
        const commented = [`// ${name}`, '// ', ...source.split('\n').map(line => `// ${line}`)].join('\n')
        expect(pdf, `${name} must be visible in package/lib/client.pdf.js`).toContain(commented)
      }
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
