/**
 * M6 performance budgets (P01 §12/§13):
 * - a 100k-file workspace indexes under the 3 s budget WITH bounded truncation;
 * - a 50 MiB upload keeps its memory peak far below a 2x-chunk runaway;
 * - console model windowing math stays cheap at 5000 entries.
 *
 * Machine-noise tolerance: wall-clock assertions carry documented headroom
 * (local budget x2) because shared CI runners jitter; they are tripwires for
 * ORDER-OF-MAGNITUDE regressions, not micro-benchmarks (P01 §12 wording).
 */
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  defaultTestConfig,
  makeDomain,
  makeTempDir,
  removeTempDir,
  startRouteServer,
  uploadRequest,
} from '../server/helpers.client.js'
import { createWorkspaceIndexer } from '../../src/server/workspace.js'
import {
  buildRows,
  computeWindow,
  filterEntries,
} from '../../src/client/console/model.js'
import type { ConsoleEntry } from '../../src/client/console/model.js'

const agent = new http.Agent({ keepAlive: false })

let cwd: string
let closeServer: (() => Promise<void>) | undefined
let disposeDomain: (() => void) | undefined

beforeEach(async () => {
  cwd = await makeTempDir('perf')
})

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
  disposeDomain?.()
  disposeDomain = undefined
  await removeTempDir(cwd)
})

// ---------------------------------------------------------------------------
// Budget 1: 100k-file tree, indexed with bounded truncation, ≤3 s
// ---------------------------------------------------------------------------

describe('performance: 100k-file workspace index', () => {
  /**
   * Creates ~100_000 files spread over a shallow fan-out. Creation dominates
   * wall time; the BUDGET applies to walkWorkspace only and is measured after
   * the last write resolves.
   */
  async function buildHugeTree(root: string): Promise<number> {
    const TOP_DIRS = 20
    const SUB_DIRS = 5
    const FILES_PER_SUB = 1000 // 20*5*1000 = 100_000 files total
    let created = 0
    const BATCH = 500
    const pending: Array<Promise<void>> = []
    for (let top = 0; top < TOP_DIRS; top += 1) {
      for (let sub = 0; sub < SUB_DIRS; sub += 1) {
        const dir = path.join(root, `t${top}`, `s${sub}`)
        await fsp.mkdir(dir, { recursive: true })
        for (let file = 0; file < FILES_PER_SUB; file += 1) {
          pending.push(fsp.writeFile(path.join(dir, `f${file}.dat`), 'x'))
          created += 1
          if (pending.length >= BATCH) {
            await Promise.all(pending)
            pending.length = 0
          }
        }
      }
    }
    await Promise.all(pending)
    return created
  }

  it('indexes a 100k-file tree with truncated=true in ≤6 s (budget 3 s + noise x2)', async () => {
    const localCwd = await makeTempDir('perf-huge')
    try {
      const totalFiles = await buildHugeTree(localCwd)
      expect(totalFiles).toBe(100_000)

      // maxFiles stays at the shipped default so the hard stop is what saves us.
      const indexer = createWorkspaceIndexer({
        sessions: { get: () => ({ header: { cwd: localCwd } }), list: () => [] },
        storageDirName: '.filehub',
        logWarn: () => {},
      })
      const startedAt = performance.now()
      const snapshot = await indexer.get('huge-session')
      const elapsedMs = performance.now() - startedAt
      indexer.dispose()

      expect(snapshot).toBeDefined()
      expect(snapshot!.truncated).toBe(true) // bounded truncation engaged…
      expect(snapshot!.entries.length).toBeLessThanOrEqual(5000) // …at the cap
      expect(elapsedMs).toBeLessThan(6_000)
    } finally {
      await removeTempDir(localCwd)
    }
  }, 480_000) // creation of 100k files is slow on Windows; budget covers the WALK only
})

// ---------------------------------------------------------------------------
// Budget 2: 50 MiB upload memory peak
// ---------------------------------------------------------------------------

describe('performance: 50 MiB upload memory peak', () => {
  it('streams a full-size upload with peak delta well under a runaway ceiling', async () => {
    const { domain, route } = makeDomain(
      [{ id: 'big', cwd }],
      {
        ...defaultTestConfig(),
        upload: {
          maxBytes: 60 * 1024 * 1024,
          maxConcurrent: 1,
          perSessionQuotaBytes: 128 * 1024 * 1024,
        },
      },
    )
    disposeDomain = () => { domain.dispose() }
    const server = await startRouteServer(route)
    closeServer = () => server.close()

    const MIB = 1024 * 1024
    const body = new Uint8Array(50 * MIB)
    // Real PDF head so the byte sniffer classifies it ('%PDF-' + version).
    Buffer.from('%PDF-1.7').copy(Buffer.from(body.buffer, body.byteOffset, 8))

    // Warm-up round-trip so lazy module/JIT allocations do not pollute deltas.
    const warm = await uploadRequest(agent, server.port, {
      sessionId: 'big',
      fileName: 'warm.bin',
      body: new Uint8Array(1024),
    })
    expect(warm.status).toBe(200)

    const before = process.memoryUsage()
    const res = await uploadRequest(agent, server.port, {
      sessionId: 'big',
      fileName: 'big.pdf',
      body,
    })
    const after = process.memoryUsage()

    expect(res.status).toBe(200)
    const result = JSON.parse(res.text) as { sniffedType: string }
    expect(result.sniffedType).toBe('application/pdf')

    // Strict intent: peak ≈ one extra copy of the 50 MiB body (~100 MiB).
    // CI tolerance: heap+arrayBuffers deltas jitter with GC timing, so the
    // tripwire sits at 160 MiB — an order-of-magnitude guard against
    // unbounded buffering, not a precise measurement.
    const deltaHeap = Math.max(0, after.heapUsed - before.heapUsed)
    const deltaBuffers = Math.max(0, after.arrayBuffers - before.arrayBuffers)
    const peakProxy = Math.max(deltaHeap, deltaBuffers)
    expect(peakProxy).toBeLessThan(160 * MIB)

    await fsp.rm(path.join(path.resolve(cwd), '.filehub'), { recursive: true, force: true })
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Budget 3: console model layer under 5000 entries
// ---------------------------------------------------------------------------

describe('performance: console model at 5000 entries', () => {
  function syntheticEntries(count: number): ConsoleEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      path: `/w/sess-${i % 7}/.filehub/f${i}.bin`,
      relativePath: `f${i}.bin`,
      name: `f${i}.bin`,
      sessionId: `sess-${i % 7}`,
      sizeBytes: 100 + i,
      uploadedAtMs: 1_700_000_000_000 + i * 1000,
      kind: (['image', 'document', 'text', 'binary', 'media'] as const)[i % 5]!,
    }))
  }

  it('filter + group + window 5000 entries well inside one frame-ish budget', () => {
    const entries = syntheticEntries(5000)
    const startedAt = performance.now()
    const filtered = filterEntries(entries, 'f49', 'all') // substring hit set
    const rows = buildRows(filtered, true)
    const windowTop = computeWindow(rows.length, 0, 600, 48)
    const windowTail = computeWindow(rows.length, (rows.length - 1) * 48, 600, 48)
    const elapsedMs = performance.now() - startedAt

    expect(filtered.length).toBeGreaterThan(0)
    expect(rows.length).toBe(filtered.length + 7) // one header per session group
    // Window invariants hold at both extremes.
    expect(windowTop.start).toBe(0)
    expect(windowTop.padTop).toBe(0)
    expect(windowTail.end).toBe(rows.length)
    expect(Math.round(windowTop.padBottom + windowTop.padTop)).toBeLessThanOrEqual(rows.length * 48)
    // Model-layer work for 5000 entries stays trivially cheap (<50 ms local,
    // x4 CI noise documented).
    expect(elapsedMs).toBeLessThan(200)
  })

  it('windowing math never renders more than viewport + overscan rows at 5000 scale', () => {
    const total = 5000
    const slice = computeWindow(total, 1234 * 48, 800, 48, 6)
    expect(slice.end - slice.start).toBeLessThanOrEqual(Math.ceil(800 / 48) + 12)
    expect(slice.padBottom).toBe((total - slice.end) * 48)
    expect(slice.padTop).toBe(slice.start * 48)
  })
})
