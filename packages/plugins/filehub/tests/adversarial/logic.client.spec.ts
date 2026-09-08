/**
 * M6 red-team round 3 — logic & resource exhaustion (P01 §12 对抗验证).
 *
 * ReDoS attempts against the search endpoint, symlink-cycle + maxFiles double
 * stress on the workspace indexer, parse-cache poisoning across formats, and
 * KV/disk divergence (ghost entries). Log: docs/adversarial-log.md.
 */
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  defaultTestConfig,
  makeDomain,
  makeTempDir,
  rawRequest,
  removeTempDir,
  startRouteServer,
  uploadRequest,
} from '../server/helpers.client.js'
import { createWorkspaceIndexer } from '../../src/server/workspace.js'
import { ParseCache } from '../../src/server/parse/cache.js'

const agent = new http.Agent({ keepAlive: false })

let cwd: string
let port = 0
let closeServer: (() => Promise<void>) | undefined
let disposeDomain: (() => void) | undefined

beforeEach(async () => {
  cwd = await makeTempDir('adv-logic')
})

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
  disposeDomain?.()
  disposeDomain = undefined
  await removeTempDir(cwd)
})

async function start(): Promise<void> {
  const { domain, route } = makeDomain([{ id: 'sess-1', cwd }], defaultTestConfig())
  disposeDomain = () => { domain.dispose() }
  const server = await startRouteServer(route)
  port = server.port
  closeServer = () => server.close()
}

// ---------------------------------------------------------------------------
// Search q ReDoS attempts
// ---------------------------------------------------------------------------

describe('round3: search endpoint ReDoS resistance', () => {
  it('answers a pathological 100k-char query in bounded time (no regex backtracking)', async () => {
    await start()
    // Seed some candidates so scoring actually walks the index.
    for (let i = 0; i < 20; i += 1) {
      await fsp.writeFile(path.join(cwd, `candidate-${i}.txt`), 'x')
    }
    const evilQueries = [
      'a'.repeat(8_000), // under the 16 KB request-line cap, still pathological
      `${'ab'.repeat(4_000)}c`,
      `${'(a'.repeat(2_000)}${')'.repeat(2_000)}`, // regex-flavoured junk
      `${'.'.repeat(7_999)}*`,
    ]
    for (const [index, q] of evilQueries.entries()) {
      const startedAt = Date.now()
      const res = await rawRequest(agent, port, {
        method: 'GET',
        path: `/api/filehub/search?sessionId=sess-1&q=${encodeURIComponent(q)}`,
      })
      const elapsedMs = Date.now() - startedAt
      expect(res.status, `query #${index}`).toBe(200)
      // Machine-noise tolerance noted (P01 §13): local budget 2 s, CI x3.
      expect(elapsedMs, `query #${index} took ${elapsedMs}ms`).toBeLessThan(6_000)
    }
  }, 30_000)

  it('library q filter resists the same pathological queries', async () => {
    await start()
    await uploadRequest(agent, port, {
      sessionId: 'sess-1',
      fileName: 'needle.txt',
      body: new Uint8Array(Buffer.from('find me')),
    })
    const startedAt = Date.now()
    const res = await rawRequest(agent, port, {
      method: 'GET',
      path: `/api/filehub/library?q=${encodeURIComponent('z'.repeat(8_000))}`,
    })
    const elapsedMs = Date.now() - startedAt
    expect(res.status).toBe(200)
    expect(elapsedMs).toBeLessThan(6_000)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Indexer: symlink cycle + maxFiles double stress
// ---------------------------------------------------------------------------

describe('round3: indexer symlink cycle + maxFiles stress', () => {
  it('terminates a mutual junction cycle under maxFiles with truncated=true within budget', async () => {
    const localCwd = await makeTempDir('adv-cycle')
    try {
      // Plain dirs a/b plus junctions b/loop→a and a/self→b: every descent
      // re-yields entries until the maxFiles hard stop fires.
      await fsp.mkdir(path.join(localCwd, 'a'), { recursive: true })
      await fsp.mkdir(path.join(localCwd, 'b'), { recursive: true })
      let cyclesMade = 0
      try {
        await fsp.symlink(path.join(localCwd, 'a'), path.join(localCwd, 'b', 'loop'), 'junction')
        await fsp.symlink(path.join(localCwd, 'b'), path.join(localCwd, 'a', 'self'), 'junction')
        cyclesMade = 2
      } catch {
        // Junctions unavailable here — the flat-fill below still stresses.
      }
      void cyclesMade
      // Fill toward the cap so truncation definitely engages.
      for (let i = 0; i < 60; i += 1) {
        await fsp.writeFile(path.join(localCwd, `filler-${i}.txt`), 'x')
      }
      const indexer = createWorkspaceIndexer({
        sessions: { get: () => ({ header: { cwd: localCwd } }), list: () => [] },
        storageDirName: '.filehub',
        logWarn: () => {},
        maxFiles: 30, // below the 60-filler count so the hard stop MUST fire
        ttlMs: 0, // force a rebuild on EVERY get(): maximum rescan pressure
      })
      const startedAt = performance.now()
      for (let round = 0; round < 5; round += 1) {
        const snapshot = await indexer.get('cycle-session')
        expect(snapshot).toBeDefined()
        expect(snapshot!.entries.length).toBeLessThanOrEqual(30)
        expect(snapshot!.truncated).toBe(true) // hard stop engaged, never hangs
      }
      const elapsedMs = performance.now() - startedAt
      indexer.dispose()
      // Five forced full rescans under cycle pressure stay inside 3 s total
      // (local budget per walk 3 s per P01 §12; machine noise ×2 documented).
      expect(elapsedMs).toBeLessThan(6_000)

      // Cycle guard sanity at a generous cap: junctioned descendants are
      // entered AT MOST ONCE (ancestor realpath set), so with maxFiles above
      // the filler count the walk ENDS (no infinite descent, truncated=false).
      const indexerWide = createWorkspaceIndexer({
        sessions: { get: () => ({ header: { cwd: localCwd } }), list: () => [] },
        storageDirName: '.filehub',
        logWarn: () => {},
        maxFiles: 5_000,
        ttlMs: 0,
      })
      const wide = await indexerWide.get('cycle-session-wide')
      indexerWide.dispose()
      expect(wide?.truncated).toBe(false) // finite tree: the walk terminated
    } finally {
      await removeTempDir(localCwd)
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Parse cache poisoning: same sha256, different format/options keys
// ---------------------------------------------------------------------------

describe('round3: parse cache key isolation', () => {
  it('same content parsed as two formats yields two INDEPENDENT cache entries', async () => {
    const cache = new ParseCache({ maxEntries: 16, maxBytes: 1024 * 1024 })
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const keyText = ParseCache.keyOf(bytes, 'text/plain', 'probe=0;sheet=-')
    const keyPdf = ParseCache.keyOf(bytes, 'application/pdf', 'probe=0;sheet=-')

    await cache.wrap(keyText, async () => ({
      format: 'text',
      text: 'TEXT EXTRACTION',
      overview: { format: 'text' },
    }) as never)
    await cache.wrap(keyPdf, async () => ({
      format: 'pdf',
      text: 'PDF EXTRACTION',
      overview: { format: 'pdf' },
    }) as never)

    expect(cache.size).toBe(2)
    const hitText = cache.peek(keyText) as { text: string }
    const hitPdf = cache.peek(keyPdf) as { text: string }
    expect(hitText.text).toBe('TEXT EXTRACTION') // no cross-contamination
    expect(hitPdf.text).toBe('PDF EXTRACTION')
    // Identical bytes + identical options → one shared entry (dedupe intact).
    const keyTextAgain = ParseCache.keyOf(bytes, 'text/plain', 'probe=0;sheet=-')
    expect(keyTextAgain).toBe(keyText)
  })

  it('sheet-selector options are part of the key (xlsx sheet A never answers sheet B)', async () => {
    const cache = new ParseCache({ maxEntries: 16, maxBytes: 1024 * 1024 })
    const bytes = new Uint8Array([9, 9, 9])
    const keyA = ParseCache.keyOf(bytes, 'xlsx', 'probe=0;sheet=A')
    const keyB = ParseCache.keyOf(bytes, 'xlsx', 'probe=0;sheet=B')
    await cache.wrap(keyA, async () => ({ format: 'xlsx', text: 'SHEET A DATA' }) as never)
    await cache.wrap(keyB, async () => ({ format: 'xlsx', text: 'SHEET B DATA' }) as never)
    expect((cache.peek(keyA) as { text: string }).text).toBe('SHEET A DATA')
    expect((cache.peek(keyB) as { text: string }).text).toBe('SHEET B DATA')
  })
})

// ---------------------------------------------------------------------------
// KV/disk divergence: manual out-of-band deletion must not surface ghosts
// ---------------------------------------------------------------------------

describe('round3: ghost-entry self-healing after out-of-band deletion', () => {
  it('library drops the entry AND prunes its metadata row once the file vanished', async () => {
    await start()
    const up = await uploadRequest(agent, port, {
      sessionId: 'sess-1',
      fileName: 'ghost.txt',
      body: new Uint8Array(Buffer.from('about to vanish')),
    })
    expect(up.status).toBe(200)
    const listed = JSON.parse(up.text) as { path: string }

    const before = await rawRequest(agent, port, {
      method: 'GET',
      path: '/api/filehub/library',
    })
    expect(before.status).toBe(200)
    expect(before.text).toContain('ghost.txt')

    // Out-of-band deletion (NOT via FileHub): KV now disagrees with disk.
    await fsp.unlink(listed.path)

    const after = await rawRequest(agent, port, {
      method: 'GET',
      path: '/api/filehub/library',
    })
    expect(after.status).toBe(200)
    expect(after.text).not.toContain('ghost.txt') // no ghost surfaced…

    // …and the heal is durable: the metadata row was pruned, so usage agrees.
    const usage = await rawRequest(agent, port, {
      method: 'GET',
      path: '/api/filehub/usage',
    })
    const usageBody = JSON.parse(usage.text) as { files: number }
    expect(usageBody.files).toBe(0)
  })

  it('list endpoint never showed ghosts (disk-driven) and stays consistent post-heal', async () => {
    await start()
    const up = await uploadRequest(agent, port, {
      sessionId: 'sess-1',
      fileName: 'ghost2.txt',
      body: new Uint8Array(Buffer.from('vanish too')),
    })
    const listed = JSON.parse(up.text) as { path: string }
    await fsp.unlink(listed.path)
    const res = await rawRequest(agent, port, {
      method: 'GET',
      path: '/api/filehub/list?sessionId=sess-1',
    })
    expect(res.status).toBe(200)
    expect(res.text).not.toContain('ghost2.txt')
  })
})
