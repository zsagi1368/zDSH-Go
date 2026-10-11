/**
 * Registry-source install suite: `npm:` sources through an injected
 * in-memory registry double — resolution, download, sha512 verification,
 * strict tar extraction (traversal/link/refusal matrix), origin-ledger
 * driven uninstall hygiene, and fail-closed re-admission after reinstall.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import PluginGovernanceGateway, { type PluginGovernanceId } from '../src/index.ts'
import {
  NpmSourceError,
  parseNpmSpec,
  registryOriginFromConfig,
  type HttpLike,
} from '../src/install/registry-source.ts'
import {
  TarExtractionError,
  extractNpmPackageTarball,
} from '../src/install/tarball.ts'

const storageRoots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const root of storageRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Brand a raw id for gateway calls. */
function gid(value: string): PluginGovernanceId {
  return value as PluginGovernanceId
}

// ---- tar writer (mirrors what `npm pack` emits: ustar, root `package/`) ----

/** One 512-byte ustar header block with a valid checksum. */
function tarHeader(name: string, size: number, typeflag: string): Buffer {
  const header = Buffer.alloc(512, 0)
  header.write(name.slice(0, 100), 0, 'latin1')
  header.write('0000644\0', 100, 'latin1')
  header.write('0000000\0', 108, 'latin1')
  header.write('0000000\0', 116, 'latin1')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  header.write('00000000000\0', 136, 'latin1')
  header.write(typeflag.slice(0, 1), 156, 'latin1')
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  let checksum = 0
  for (let index = 0; index < 512; index += 1) {
    checksum += index >= 148 && index < 156 ? 0x20 : header.readUInt8(index)
  }
  header.write(`${checksum.toString(8).padStart(7, '0')}\0`, 148, 'latin1')
  return header
}

/** Assemble entries into a tarball with the conventional `package/` root. */
function buildNpmTar(entries: Array<{ name: string; data?: string | Buffer; typeflag?: string }>): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const stored = entry.name.startsWith('/') || /^[A-Za-z]:|\\/u.test(entry.name)
      ? entry.name
      : entry.name.startsWith('package/') ? entry.name : `package/${entry.name}`
    const typeflag = entry.typeflag ?? (stored.endsWith('/') ? '5' : '0')
    if (typeflag !== '0' && typeflag !== '5') {
      chunks.push(tarHeader(stored, 0, typeflag))
      continue
    }
    if (typeflag === '5') {
      chunks.push(tarHeader(stored, 0, '5'))
      continue
    }
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data ?? Buffer.alloc(0)
    chunks.push(tarHeader(stored, data.length, '0'))
    chunks.push(data)
    const padding = (512 - (data.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

// ---- registry double served through the injected transport ----

interface RegistryDouble {
  origin: string
  /** The transport to hand the gateway constructor. */
  http: HttpLike
}

/**
 * An https-flavored fake origin whose responses come straight from memory.
 * The client pins every hop to this origin, so the double also proves that
 * production code paths accept a non-default allow-listed origin.
 */
function registryDouble(routes: Record<string, { status?: number; location?: string; body?: Buffer; contentType?: string } | 'refused'>): RegistryDouble {
  const origin = 'https://registry.test'
  const http: HttpLike = async (url, init) => {
    void init
    const path = new URL(url).pathname
    // Unknown paths answer 404 like the real registry; only the explicit
    // 'refused' marker simulates an unreachable network.
    const route = routes[path] ?? { status: 404 }
    if (route === 'refused') throw new TypeError('fetch failed')
    if (route.location !== undefined) {
      return new Response(null, { status: route.status ?? 302, headers: { location: route.location } })
    }
    const body = route.body ?? Buffer.alloc(0)
    return new Response(new Uint8Array(body), {
      status: route.status ?? 200,
      headers: { 'content-length': String(body.length), ...(route.contentType === undefined ? {} : { 'content-type': route.contentType }) },
    })
  }
  return { origin, http }
}

/** Package.json payload inside most fixture tarballs. */
function pluginPackageJson(version = '1.0.0'): string {
  return JSON.stringify({
    name: '@demo/plugin',
    version,
    displayName: 'Demo Plugin',
    dsh: {
      compatible: '>=0.0.0',
      capabilities: [
        { type: 'tool', tool: { name: 'demo_tool', description: 'fixture tool', schema: { type: 'object' } } },
      ],
    },
  })
}

/** Packument body advertising one release of @demo/plugin. */
function packument(origin: string, version: string, tarballBody: Buffer): Buffer {
  return Buffer.from(JSON.stringify({
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name: '@demo/plugin',
        version,
        dist: {
          tarball: `${origin}/demo/plugin/-/plugin-${version}.tgz`,
          integrity: `sha512-${createHash('sha512').update(tarballBody).digest('base64')}`,
        },
      },
    },
  }))
}

/** A directly constructed gateway over a private storage root. */
async function gatewayOn(double: RegistryDouble): Promise<PluginGovernanceGateway> {
  const ctx = new Context()
  contexts.push(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'gov-npm-'))
  storageRoots.push(storageRoot)
  const gateway = new PluginGovernanceGateway(
    ctx,
    { storageRoot, registryUrl: double.origin },
    undefined,
    { http: double.http },
  )
  // Direct construction skips loader wiring; run the service init effects so
  // approvals/ledger hydration behaves exactly like a mounted deployment.
  const self = gateway as unknown as Record<symbol, () => Promise<void>>
  const init = self[Service.init]
  if (init === undefined) throw new Error('gateway exposes no Service.init hook')
  await init.call(self)
  return gateway
}

describe('parseNpmSpec', () => {
  it('accepts bare names, scoped names, and exact versions', () => {
    expect(parseNpmSpec('npm:left-pad')).toEqual({ name: 'left-pad' })
    expect(parseNpmSpec('npm:@demo/plugin')).toEqual({ name: '@demo/plugin' })
    expect(parseNpmSpec('npm:@demo/plugin@1.2.3')).toEqual({ name: '@demo/plugin', version: '1.2.3' })
  })

  it('rejects ranges, malformed names, and non-npm sources', () => {
    expect(parseNpmSpec('npm:x@^1.0.0')).toBeNull()
    expect(parseNpmSpec('npm:x@latest')).toBeNull()
    expect(parseNpmSpec('npm:@no-slash@1.0.0')).toBeNull()
    expect(parseNpmSpec('./some/dir')).toBeNull()
  })
})

describe('extractNpmPackageTarball', () => {
  const dest = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-tar-'))
    storageRoots.push(dir)
    return dir
  }

  it('writes regular files and directories under the destination', () => {
    const target = dest()
    const result = extractNpmPackageTarball(buildNpmTar([
      { name: 'package/' },
      { name: 'package/package.json', data: '{}' },
      { name: 'package/lib/engine.js', data: 'export {}' },
    ]), target)
    expect(result.fileCount).toBe(2)
    expect(readFileSync(join(target, 'lib', 'engine.js'), 'utf8')).toBe('export {}')
  })

  it('refuses traversal segments, absolute paths, drive letters, and backslashes', () => {
    const target = dest()
    for (const name of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/win.ini', 'bad\\name.js']) {
      expect(() => extractNpmPackageTarball(buildNpmTar([{ name, data: 'x' }]), target), name)
        .toThrow(TarExtractionError)
    }
  })

  it('refuses links and devices and GNU long-name extensions', () => {
    const target = dest()
    for (const typeflag of ['1', '2', '3', '4', '6', 'L']) {
      const tar = buildNpmTar([{ name: 'package/link.js', typeflag }])
      expect(() => extractNpmPackageTarball(tar, target), typeflag).toThrow(TarExtractionError)
    }
  })

  it('rejects corrupted headers and archives without files', () => {
    const target = dest()
    const corrupt = buildNpmTar([{ name: 'package/a.js', data: 'x' }])
    corrupt[200] = (corrupt.readUInt8(200) ^ 0xff) & 0xff
    expect(() => extractNpmPackageTarball(corrupt, target)).toThrow(TarExtractionError)
    expect(() => extractNpmPackageTarball(Buffer.alloc(1024), target)).toThrow(TarExtractionError)
  })

  it('enforces entry, per-file, and cumulative size caps', () => {
    const target = dest()
    const many = Array.from({ length: 4 }, (_, i) => ({ name: `f${String(i)}.js`, data: 'x' }))
    expect(() => extractNpmPackageTarball(buildNpmTar(many), target, { maxEntries: 3, maxTotalBytes: 1024, maxFileBytes: 1024 }))
      .toThrow('too many entries')
    expect(() => extractNpmPackageTarball(buildNpmTar([{ name: 'big.js', data: 'x'.repeat(64) }]), target, { maxEntries: 10, maxTotalBytes: 1024, maxFileBytes: 32 }))
      .toThrow('size cap')
    expect(() => extractNpmPackageTarball(buildNpmTar([{ name: 'a.js', data: 'x'.repeat(48) }, { name: 'b.js', data: 'y'.repeat(48) }]), target, { maxEntries: 10, maxTotalBytes: 64, maxFileBytes: 64 }))
      .toThrow('total size cap')
  })
})

describe('npm: installs through the gateway', () => {
  it('resolves an exact version, verifies integrity, extracts, and registers disabled', async () => {
    const tarball = buildNpmTar([
      { name: 'package/package.json', data: pluginPackageJson() },
      { name: 'package/index.js', data: 'export const engine = 1' },
    ])
    const double = registryDouble({
      '/demo/plugin': { body: packument('https://registry.test', '1.0.0', tarball), contentType: 'application/json' },
      '/demo/plugin/-/plugin-1.0.0.tgz': { body: tarball, contentType: 'application/x-tar' },
    })
    const gateway = await gatewayOn(double)
    const result = await gateway.install({ source: 'npm:@demo/plugin@1.0.0' })
    expect(result.ok).toBe(true)
    const detail = gateway.get({ pluginId: gid('@demo/plugin') })
    expect(detail.ok).toBe(true)
    if (detail.ok) {
      // Fail closed: no approval decision exists yet, so the plugin stays off.
      expect(detail.value.summary.status).toBe('disabled')
      expect(detail.value.summary.approved).toBe(false)
    }
    // Registry ids are canonicalized (`@scope/name` loses the sigil), so
    // assert on the single roster row rather than a spelled-out id.
    const roster = gateway.list().plugins
    expect(roster).toHaveLength(1)
    expect(roster[0]?.source).toBe('native')
    // The extracted tree lives under the storage area's installed/ directory.
    const installedDir = join(String(storageRoots.at(-1)), 'installed', 'demo', 'plugin')
    expect(existsSync(join(installedDir, 'package.json'))).toBe(true)
    expect(existsSync(join(installedDir, 'index.js'))).toBe(true)
  })

  it('falls back to the latest stable release when no version is pinned', async () => {
    const older = buildNpmTar([{ name: 'package/package.json', data: pluginPackageJson('0.9.0') }])
    const newer = buildNpmTar([{ name: 'package/package.json', data: pluginPackageJson('1.2.0') }])
    const double = registryDouble({
      '/demo/plugin': {
        body: Buffer.from(JSON.stringify({
          'dist-tags': {},
          versions: {
            '0.9.0': { dist: { tarball: 'https://registry.test/demo/plugin/-/plugin-0.9.0.tgz', integrity: `sha512-${createHash('sha512').update(older).digest('base64')}` } },
            '1.2.0': { dist: { tarball: 'https://registry.test/demo/plugin/-/plugin-1.2.0.tgz', integrity: `sha512-${createHash('sha512').update(newer).digest('base64')}` } },
          },
        })),
        contentType: 'application/json',
      },
      '/demo/plugin/-/plugin-1.2.0.tgz': { body: newer, contentType: 'application/x-tar' },
    })
    const gateway = await gatewayOn(double)
    const result = await gateway.install({ source: 'npm:@demo/plugin' })
    expect(result.ok).toBe(true)
    const detail = gateway.get({ pluginId: gid('@demo/plugin') })
    if (detail.ok) expect(detail.value.summary.version).toBe('1.2.0')
  })

  it('reports unknown packages as request-invalid without registering anything', async () => {
    const double = registryDouble({})
    const gateway = await gatewayOn(double)
    const result = await gateway.install({ source: 'npm:@demo/missing@1.0.0' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('request-invalid')
    expect(gateway.list().plugins).toHaveLength(0)
  })

  it('maps unreachable registries to registry-unavailable', async () => {
    const double = registryDouble({ '/demo/plugin': 'refused' })
    const gateway = await gatewayOn(double)
    const result = await gateway.install({ source: 'npm:@demo/plugin@1.0.0' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('registry-unavailable')
  })

  it('maps traversal-carrying tarballs to request-invalid and cleans up', async () => {
    const evil = buildNpmTar([{ name: 'package/../evil.js', data: 'x' }])
    const double = registryDouble({
      '/demo/plugin': { body: packument('https://registry.test', '1.0.0', evil), contentType: 'application/json' },
      '/demo/plugin/-/plugin-1.0.0.tgz': { body: evil, contentType: 'application/x-tar' },
    })
    const gateway = await gatewayOn(double)
    const result = await gateway.install({ source: 'npm:@demo/plugin@1.0.0' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('request-invalid')
    expect(existsSync(join(String(storageRoots.at(-1)), 'installed'))).toBe(false)
  })

  it('rejects downloads whose bytes do not match the published sha512 digest', async () => {
    const honest = buildNpmTar([{ name: 'package/package.json', data: pluginPackageJson() }])
    const tampered = Buffer.from(honest)
    const flipAt = tampered.length - 600
    tampered[flipAt] = (tampered.readUInt8(flipAt) + 1) % 256
    const double = registryDouble({
      '/demo/plugin': { body: packument('https://registry.test', '1.0.0', honest), contentType: 'application/json' },
      '/demo/plugin/-/plugin-1.0.0.tgz': { body: tampered, contentType: 'application/x-tar' },
    })
    const gateway = await gatewayOn(double)
    const result = await gateway.install({ source: 'npm:@demo/plugin@1.0.0' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('registry-unavailable')
    expect(gateway.list().plugins).toHaveLength(0)
  })

  it('refuses redirects that leave the configured registry origin', async () => {
    const double = registryDouble({
      '/demo/plugin': { status: 302, location: 'https://evil.example/demo/plugin' },
    })
    const gateway = await gatewayOn(double)
    const result = await gateway.install({ source: 'npm:@demo/plugin@1.0.0' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('registry-unavailable')
  })

  it('uninstall removes the extracted tree and reinstall fails closed again', async () => {
    const tarball = buildNpmTar([{ name: 'package/package.json', data: pluginPackageJson() }])
    const double = registryDouble({
      '/demo/plugin': { body: packument('https://registry.test', '1.0.0', tarball), contentType: 'application/json' },
      '/demo/plugin/-/plugin-1.0.0.tgz': { body: tarball, contentType: 'application/x-tar' },
    })
    const gateway = await gatewayOn(double)
    expect((await gateway.install({ source: 'npm:@demo/plugin@1.0.0' })).ok).toBe(true)
    expect(gateway.approve({ pluginId: gid('@demo/plugin') }).ok).toBe(true)
    expect((await gateway.enable({ pluginId: gid('@demo/plugin') })).ok).toBe(true)
    const installedDir = join(String(storageRoots.at(-1)), 'installed', 'demo', 'plugin')
    expect(existsSync(installedDir)).toBe(true)

    expect((await gateway.uninstall({ pluginId: gid('@demo/plugin') })).ok).toBe(true)
    expect(existsSync(installedDir)).toBe(false)

    // Reinstall must NOT inherit the earlier approval: fail closed again.
    expect((await gateway.install({ source: 'npm:@demo/plugin@1.0.0' })).ok).toBe(true)
    const detail = gateway.get({ pluginId: gid('@demo/plugin') })
    if (detail.ok) expect(detail.value.summary.status).toBe('disabled')
  })

  it('P-9b: a tombstone write failure on an npm install warns and still completes the uninstall', async () => {
    // P-9b (DESIGN §1.2 [P-9b 附裁], EXEC8 整改): the fatal tombstone semantics
    // only gate `origin=preinstall` rows — the sole rows a later preinstall
    // pass could resurrect. An npm: install has no pass-resurrectable row, so
    // the same injected writer-lock failure that fails the preinstall half
    // (preinstall.spec.ts) must here be non-fatal: warn on record, uninstall
    // completed, storage tree reclaimed.
    const tarball = buildNpmTar([{ name: 'package/package.json', data: pluginPackageJson() }])
    const double = registryDouble({
      '/demo/plugin': { body: packument('https://registry.test', '1.0.0', tarball), contentType: 'application/json' },
      '/demo/plugin/-/plugin-1.0.0.tgz': { body: tarball, contentType: 'application/x-tar' },
    })
    const gateway = await gatewayOn(double)
    expect((await gateway.install({ source: 'npm:@demo/plugin@1.0.0' })).ok).toBe(true)
    const installedDir = join(String(storageRoots.at(-1)), 'installed', 'demo', 'plugin')
    // Pin the precondition the narrowing keys on: origin row kind npm.
    const rows = [...(gateway as unknown as { installedSources: Map<string, Record<string, unknown>> }).installedSources.values()]
    expect(rows.find(r => r.kind === 'npm')).toBeDefined()
    expect(rows.some(r => r.kind === 'preinstall')).toBe(false)

    const warnings: string[] = []
    const internals = gateway as unknown as {
      preinstaller: { recordUninstall: (id: string) => Promise<boolean> }
      warn(message: string): void
    }
    internals.warn = (message) => { warnings.push(message) }
    internals.preinstaller.recordUninstall = async () => { throw new Error('injected writer-lock failure') }

    const removed = await gateway.uninstall({ pluginId: gid('@demo/plugin') })
    expect(removed.ok).toBe(true)
    // The warning is on record and names both the failed write and its cause.
    expect(warnings.some(w => w.includes('tombstone') && w.includes('injected writer-lock failure'))).toBe(true)
    // Uninstall semantics fully intact: gone from the roster, tree reclaimed.
    expect(gateway.list().plugins.some(p => p.pluginId === gid('@demo/plugin'))).toBe(false)
    expect(existsSync(installedDir)).toBe(false)
  })
})

describe('configuration surface', () => {
  it('pins the configured mirror origin instead of npmjs', async () => {
    expect(() => registryOriginFromConfig('http://registry.npmjs.org')).toThrow(NpmSourceError)
    expect(() => registryOriginFromConfig('https://user:pw@registry.npmjs.org')).toThrow(NpmSourceError)
    expect(() => registryOriginFromConfig('https://registry.npmjs.org/path?q=1')).toThrow(NpmSourceError)
    expect(registryOriginFromConfig('https://registry.npmjs.org')).toBe('https://registry.npmjs.org')
  })
})
