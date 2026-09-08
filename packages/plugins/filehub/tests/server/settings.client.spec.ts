/**
 * M5 settings center over the REAL HTTP route: zod validation (400 paths),
 * server-owned sanitization/normalization, partial-PUT merge semantics, and
 * KV round-trip persistence across service instances.
 */

import { describe, expect, it } from 'vitest'
import http from 'node:http'

import {
  defaultTestConfig,
  makeFakeContext,
  rawRequest,
  startRouteServer,
} from './helpers.client.js'
import { createFileHubDomain } from '../../src/index.js'
import { createSettingsService, mergeSettings, FILEHUB_SETTINGS_DEFAULTS } from '../../src/server/settings.js'
import type { KvFacetLike, KvUnitLike, StorageHubLike } from '../../src/server/meta.js'
import type { FileHubSettings } from '../../src/server/settings.js'

const agent = new http.Agent({ keepAlive: false })

interface DomainHandle {
  port: number
  close: () => Promise<void>
}

async function startDomainWith(storage?: StorageHubLike): Promise<DomainHandle> {
  const fake = makeFakeContext([{ id: 'sess-a', cwd: 'C:/nowhere' }])
  const ctx = { ...fake.ctx, ...(storage !== undefined ? { storage } : {}) }
  const domain = createFileHubDomain(ctx, {
    ...defaultTestConfig(),
    lifecycle: {
      ttlMs: defaultTestConfig().lifecycle?.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 3_600_000,
    },
  })
  const route = fake.routes[0]
  if (!route) throw new Error('no route captured')
  const server = await startRouteServer(route)
  return {
    port: server.port,
    close: async () => {
      domain.dispose()
      await server.close()
    },
  }
}

/** In-memory KV hub faithful to the meta.ts seam shape. */
function makeFakeKvStorage(): { hub: StorageHubLike; dump: () => Record<string, unknown> } {
  const store = new Map<string, unknown>()
  const kv: KvFacetLike = {
    async open(descriptor) {
      void descriptor
      const unit: KvUnitLike = {
        async loadAll() {
          return { tables: { values: Object.fromEntries(store) }, global: null }
        },
        async putRecord(table, key, value) {
          void table
          store.set(key, value)
        },
        async deleteRecord(table, key) {
          void table
          store.delete(key)
        },
        async close() {},
      }
      return unit
    },
  }
  return {
    hub: { backend: { names: () => ['fake'], get: () => ({ kv }) } },
    dump: () => Object.fromEntries(store),
  }
}

function put(port: number, body: string): Promise<{ status: number; text: string }> {
  return rawRequest(agent, port, {
    method: 'PUT',
    path: '/api/filehub/settings',
    headers: { 'content-type': 'application/json' },
    body: new Uint8Array(Buffer.from(body)),
  }).then(response => ({ status: response.status, text: response.text }))
}

async function get(port: number): Promise<FileHubSettings> {
  const response = await rawRequest(agent, port, { method: 'GET', path: '/api/filehub/settings' })
  expect(response.status).toBe(200)
  return JSON.parse(response.text) as FileHubSettings
}

describe('GET /api/filehub/settings', () => {
  it('serves the full defaults view when nothing was stored', async () => {
    const { close, port } = await startDomainWith()
    try {
      expect(await get(port)).toEqual(FILEHUB_SETTINGS_DEFAULTS)
    } finally {
      await close()
    }
  })

  it('works without a KV facet (memory fallback)', async () => {
    const { close, port } = await startDomainWith(undefined)
    try {
      const merged = await get(port)
      expect(merged.enabled).toBe(true)
    } finally {
      await close()
    }
  })
})

describe('PUT /api/filehub/settings', () => {
  it('rejects invalid values with 400 before writing anything', async () => {
    const { close, port } = await startDomainWith()
    try {
      expect((await put(port, JSON.stringify({ enabled: 'yes' }))).status).toBe(400)
      expect((await put(port, JSON.stringify({ 'candidates.max': 0 }))).status).toBe(400)
      expect((await put(port, JSON.stringify({ 'candidates.max': 5000 }))).status).toBe(400)
      expect((await put(port, JSON.stringify({ 'vision.mode': 'bogus' }))).status).toBe(400)
      expect((await put(port, JSON.stringify({ 'console.defaultView': 'grid' }))).status).toBe(400)
      expect((await put(port, '{not json')).status).toBe(400)
      // Nothing stuck.
      expect(await get(port)).toEqual(FILEHUB_SETTINGS_DEFAULTS)
    } finally {
      await close()
    }
  })

  it('normalizes hostile input: unknown keys stripped from the persisted record', async () => {
    const { hub, dump } = makeFakeKvStorage()
    const { close, port } = await startDomainWith(hub)
    try {
      const response = await put(
        port,
        JSON.stringify({ enabled: false, evilKey: '<script>', __proto__: {} }),
      )
      expect(response.status).toBe(200)
      const stored = dump()['filehub'] as Record<string, unknown>
      expect(stored).toMatchObject({ enabled: false })
      // Every persisted key is a KNOWN settings key — hostile keys never land.
      const known = new Set(Object.keys(FILEHUB_SETTINGS_DEFAULTS))
      for (const key of Object.keys(stored)) {
        expect(known.has(key)).toBe(true)
      }
      // The merged view carries no trace of the injected keys.
      const view = await get(port)
      expect(Object.keys(view).sort()).toEqual(Object.keys(FILEHUB_SETTINGS_DEFAULTS).sort())
    } finally {
      await close()
    }
  })

  it('merges partial patches onto prior state and round-trips through KV', async () => {
    const { hub } = makeFakeKvStorage()
    const { close, port } = await startDomainWith(hub)
    try {
      expect((await put(port, JSON.stringify({ 'console.defaultView': 'flat' }))).status).toBe(200)
      let view = await get(port)
      expect(view['console.defaultView']).toBe('flat')
      expect(view['candidates.max']).toBe(FILEHUB_SETTINGS_DEFAULTS['candidates.max'])

      expect(
        (await put(port, JSON.stringify({ 'candidates.max': 7, ignorePastedMentions: true }))).status,
      ).toBe(200)
      view = await get(port)
      expect(view).toEqual({
        ...FILEHUB_SETTINGS_DEFAULTS,
        'console.defaultView': 'flat',
        'candidates.max': 7,
        ignorePastedMentions: true,
      })

      // A second service instance over the SAME hub sees the persisted state —
      // proving real KV round-trip, not process-local memory.
      const second = createSettingsService({ storage: hub, logWarn: () => {} })
      expect(await second.get()).toEqual(view)
    } finally {
      await close()
    }
  })
})

describe('pure helpers', () => {
  it('mergeSettings keeps base values for absent keys', () => {
    const merged = mergeSettings(FILEHUB_SETTINGS_DEFAULTS, { 'vision.mode': 'off' })
    expect(merged['vision.mode']).toBe('off')
    expect(merged.enabled).toBe(true)
  })
})
