import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '../../src/host/snapshot.js'
import type { HttpPort, FileSystemPort } from '../../src/host/ports.js'
import { nodePorts } from '../../src/host/ports.js'

const COMMIT = 'e'.repeat(40)

const goodEntry = {
  id: 'owner/repo',
  source: 'github',
  owner: 'owner',
  repo: 'repo',
  pinnedCommit: COMMIT,
  title: { zh: '条目', en: 'Entry' },
  summary: { zh: '摘要', en: 'Summary' },
  category: 'misc',
  evidence: 'installable',
  compat: 'unknown',
  scriptsPolicy: 'none',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

const REMOTE_URL = 'https://registry.example.com/catalog.json'

function makeFs(): FileSystemPort {
  return nodePorts().fs
}

function tempLayout(): { root: string; seedPath: string; cachePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'pc-snap-'))
  const seedPath = join(root, 'seed.json')
  const cachePath = join(root, 'cache.json')
  return { root, seedPath, cachePath }
}

function httpWith(responses: Record<string, string | null>): HttpPort {
  return {
    async fetchText(url) {
      const key = String(url)
      const hit = responses[key]
      if (hit === undefined || hit === null) {
        return { ok: false as const, error: { code: 'source_unreachable' as const, message: 'down' } }
      }
      return { ok: true as const, data: hit }
    },
  }
}

function signed(body: string): Record<string, string> {
  const digest = createHash('sha256').update(body, 'utf8').digest('hex')
  return { [REMOTE_URL]: body, [`${REMOTE_URL}.sha256`]: `${digest}\n` }
}

describe('catalog three-tier loading', () => {
  it('fresh verified remote wins and rewrites the cache plus sidecar', async () => {
    const layout = tempLayout()
    const fs = makeFs()
    const remote = JSON.stringify({ version: 1, fetchedAt: '2026-08-24T00:00:00Z', entries: [goodEntry] })
    const result = await loadCatalog(
      { seedPath: layout.seedPath, cachePath: layout.cachePath, remoteUrl: REMOTE_URL },
      { fs, http: httpWith(signed(remote)) },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.mode).toBe('fresh')
      expect(result.data.entries).toHaveLength(1)
    }
    const cached = JSON.parse(readFileSync(layout.cachePath, 'utf8')) as { entries: unknown[] }
    expect(cached.entries).toHaveLength(1)
    // sidecar written next to the cache
    expect(readFileSync(`${layout.cachePath}.sha256`, 'utf8')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects an unsigned or tampered remote without touching the cache', async () => {
    const layout = tempLayout()
    const fs = makeFs()
    const remote = JSON.stringify({ version: 1, fetchedAt: '', entries: [goodEntry] })
    const unsigned: Record<string, string> = { [REMOTE_URL]: remote }
    const noSidecar = await loadCatalog(
      { seedPath: layout.seedPath, cachePath: layout.cachePath, remoteUrl: REMOTE_URL },
      { fs, http: httpWith(unsigned) },
    )
    // unsigned remote is refused, then graceful degradation finds nothing else
    expect(noSidecar.ok).toBe(false)
    if (!noSidecar.ok) expect(['source_unreachable', 'untrusted_source', 'offline_degraded']).toContain(noSidecar.error.code)

    const wrongDigest: Record<string, string> = {
      ...signed(remote),
      [`${REMOTE_URL}.sha256`]: `${'0'.repeat(64)}\n`,
    }
    const tampered = await loadCatalog(
      { seedPath: layout.seedPath, cachePath: layout.cachePath, remoteUrl: REMOTE_URL },
      { fs, http: httpWith(wrongDigest) },
    )
    expect(tampered.ok).toBe(false)
    if (!tampered.ok) expect(['untrusted_source', 'offline_degraded']).toContain(tampered.error.code)
    expect(fs.readFile(layout.cachePath)).toBeNull()
  })

  it('degrades to a digest-checked cache when the remote fails', async () => {
    const layout = tempLayout()
    const fs = makeFs()
    const cachedBody = JSON.stringify({ version: 1, fetchedAt: 'old', entries: [goodEntry] })
    writeFileSync(layout.cachePath, cachedBody, 'utf8')
    writeFileSync(
      `${layout.cachePath}.sha256`,
      createHash('sha256').update(cachedBody, 'utf8').digest('hex'),
      'utf8',
    )
    const result = await loadCatalog(
      { seedPath: layout.seedPath, cachePath: layout.cachePath, remoteUrl: REMOTE_URL },
      { fs, http: httpWith({}) },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.mode).toBe('cached')
      expect(result.data.entries).toHaveLength(1)
    }
  })

  it('ignores a tampered cache and falls back to the bundled seed', async () => {
    const layout = tempLayout()
    const fs = makeFs()
    const cachedBody = JSON.stringify({ version: 1, fetchedAt: 'evil', entries: [] })
    writeFileSync(layout.cachePath, cachedBody, 'utf8')
    writeFileSync(`${layout.cachePath}.sha256`, `${'0'.repeat(64)}\n`, 'utf8')
    writeFileSync(layout.seedPath, JSON.stringify({ version: 1, fetchedAt: '', entries: [goodEntry] }), 'utf8')
    const result = await loadCatalog(
      { seedPath: layout.seedPath, cachePath: layout.cachePath, remoteUrl: REMOTE_URL },
      { fs, http: httpWith({}) },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.mode).toBe('seed')
  })

  it('falls back to the bundled seed when offline with no cache at all', async () => {
    const layout = tempLayout()
    const fs = makeFs()
    writeFileSync(layout.seedPath, JSON.stringify({ version: 1, fetchedAt: '', entries: [goodEntry] }), 'utf8')
    const result = await loadCatalog(
      { seedPath: layout.seedPath, cachePath: layout.cachePath, remoteUrl: REMOTE_URL },
      { fs, http: httpWith({}) },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.mode).toBe('seed')
  })
})
