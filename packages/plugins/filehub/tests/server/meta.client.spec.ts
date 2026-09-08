/**
 * Metadata seam: the KV-backed store must behave exactly like the in-memory
 * one (quota + sweeper bookkeeping), speaking the structural dsh-storage
 * KvFacet/KvUnit surface (open → putRecord/deleteRecord/loadAll).
 */
import { describe, expect, it } from 'vitest'

import { createMemoryMetaStore, createMetaStore } from '../../src/server/meta.js'
import type { KvUnitLike } from '../../src/server/meta.js'

/** Minimal in-memory KvFacet standing in for a dsh-storage backend. */
function makeFakeKvFacet() {
  const tables = new Map<string, Map<string, unknown>>()
  let opened = 0
  const facet = {
    get openCount(): number {
      return opened
    },
    async open(descriptor: { name: string; version: number; tables: readonly string[]; hasGlobal: boolean }) {
      opened += 1
      expect(descriptor.name).toMatch(/^[a-z][a-z0-9_]*$/)
      const unit: KvUnitLike = {
        async loadAll() {
          const snapshot: Record<string, Record<string, unknown>> = {}
          for (const [name, records] of tables) {
            snapshot[name] = Object.fromEntries(records)
          }
          return { tables: snapshot, global: null }
        },
        async putRecord(table, key, value) {
          if (!tables.has(table)) tables.set(table, new Map())
          tables.get(table)?.set(key, value)
        },
        async deleteRecord(table, key) {
          tables.get(table)?.delete(key)
        },
        async close() {
          /* nothing to drain */
        },
      }
      return unit
    },
  }
  return facet
}

describe('memory meta store', () => {
  it('records, reads, and removes rows per session', async () => {
    const meta = createMemoryMetaStore()
    await meta.record('s1', 'a.txt', { sizeBytes: 10, uploadedAtMs: 111 }, '/tmp/wsa')
    await meta.record('s1', 'b.txt', { sizeBytes: 20, uploadedAtMs: 222 })
    await meta.record('s2', 'c.txt', { sizeBytes: 30, uploadedAtMs: 333 })

    const s1 = await meta.get('s1')
    expect(s1.cwd).toBe('/tmp/wsa')
    expect(s1.files['b.txt']).toEqual({ sizeBytes: 20, uploadedAtMs: 222 })
    expect(await meta.sessionIds()).toEqual(expect.arrayContaining(['s1', 's2']))

    await meta.remove('s1', 'a.txt')
    expect((await meta.get('s1')).files['a.txt']).toBeUndefined()
    // Removing a missing row is a no-op.
    await expect(meta.remove('ghost', 'x')).resolves.toBeUndefined()
    // Unknown session reads as an empty record.
    expect(await meta.get('unknown')).toEqual({ files: {} })
  })
})

describe('KV-backed meta store', () => {
  it('persists the same semantics through a storage backend KV facet', async () => {
    const backend = makeFakeKvFacet()
    const meta = createMetaStore(
      { backend: { names: () => ['json'], get: () => ({ kv: backend }) } },
      (message) => {
        throw new Error(`must not warn when a KV facet exists: ${message}`)
      },
    )

    await meta.record('kv-s1', 'deep/a.bin', { sizeBytes: 5, uploadedAtMs: 42 }, '/w/a')
    await meta.record('kv-s1', 'b.txt', { sizeBytes: 6, uploadedAtMs: 43 })

    const record = await meta.get('kv-s1')
    expect(record.cwd).toBe('/w/a')
    expect(record.files['deep/a.bin']).toEqual({ sizeBytes: 5, uploadedAtMs: 42 })
    expect(Object.keys(record.files)).toHaveLength(2)

    await meta.remove('kv-s1', 'deep/a.bin')
    expect((await meta.get('kv-s1')).files).toHaveProperty('b.txt')
    expect(await meta.sessionIds()).toEqual(['kv-s1'])
  })

  it('falls back to memory (with a warning) when no backend exposes a KV facet', async () => {
    const warnings: string[] = []
    const meta = createMetaStore(
      {
        backend: {
          names: () => ['blob-only'],
          get: () => ({}),
        },
      },
      message => warnings.push(message),
    )
    await meta.record('m1', 'x', { sizeBytes: 1, uploadedAtMs: 1 })
    expect(await meta.get('m1').then(r => r.files.x)).toBeDefined()
    expect(warnings).toHaveLength(1)
  })

  it('falls back to memory when the storage service is absent entirely', async () => {
    const warnings: string[] = []
    const meta = createMetaStore(undefined, message => warnings.push(message))
    expect(warnings).toHaveLength(1)
    await expect(meta.sessionIds()).resolves.toEqual([])
  })
})
