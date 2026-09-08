/**
 * M5 library console endpoints over the REAL HTTP route (fake host context):
 * cross-session aggregation, q filtering, lazy disk backfill, truncation,
 * usage buckets, whole-session deletion (containment + idempotence), and the
 * two-step cleanup contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  defaultTestConfig,
  makeDomain,
  makeTempDir,
  rawRequest,
  removeTempDir,
  startRouteServer,
  uploadRequest,
} from './helpers.client.js'

const agent = new http.Agent({ keepAlive: false })

let cwdA: string
let cwdB: string
let port = 0
let closeServer: (() => Promise<void>) | undefined
let disposeDomain: (() => void) | undefined

interface DomainHandle {
  port: number
  close: () => Promise<void>
}

async function startDomain(
  sessionSpecs: Array<{ id: string; cwd: string }>,
  config?: Parameters<typeof makeDomain>[1],
): Promise<DomainHandle> {
  const { domain, route } = makeDomain(sessionSpecs, {
    ...defaultTestConfig(),
    ...config,
    lifecycle: {
      ttlMs: defaultTestConfig().lifecycle?.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 3_600_000,
    },
  })
  const server = await startRouteServer(route)
  disposeDomain = () => { domain.dispose() }
  return { port: server.port, close: () => server.close() }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const TEXT_BYTES = new Uint8Array(Buffer.from('hello console\n', 'utf8'))
const PDF_BYTES = new Uint8Array(Buffer.from('%PDF-1.4 fake pdf body', 'utf8'))

beforeEach(async () => {
  cwdA = await makeTempDir('lib-a')
  cwdB = await makeTempDir('lib-b')
})

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
  disposeDomain?.()
  disposeDomain = undefined
  await removeTempDir(cwdA)
  await removeTempDir(cwdB)
})

async function upload(
  portValue: number,
  sessionId: string,
  fileName: string,
  body: Uint8Array,
  relPath?: string,
): Promise<void> {
  const response = await uploadRequest(agent, portValue, {
    sessionId,
    fileName,
    body,
    ...(relPath === undefined ? {} : { relPath }),
  })
  expect(response.status).toBe(200)
}

/** Fetch the library aggregate and flatten (entry, sessionId) pairs. */
async function fetchFlat(): Promise<Array<{ name: string; path: string; kind: string; sizeBytes: number; sessionId: string }>> {
  const response = await rawRequest(agent, port, { method: 'GET', path: '/api/filehub/library' })
  expect(response.status).toBe(200)
  const body = JSON.parse(response.text) as {
    sessions: Array<{
      sessionId: string
      entries: Array<{ name: string; path: string; kind: string; sizeBytes: number }>
    }>
    totalBytes: number
    truncated: boolean
  }
  return body.sessions.flatMap(session =>
    session.entries.map(entry => ({ ...entry, sessionId: session.sessionId })),
  )
}

describe('GET /api/filehub/library', () => {
  it('aggregates uploaded files across sessions with sizes and kinds', async () => {
    const handle = await startDomain([
      { id: 'sess-a', cwd: cwdA },
      { id: 'sess-b', cwd: cwdB },
    ])
    port = handle.port
    closeServer = () => handle.close()
    await upload(port, 'sess-a', 'shot.png', PNG_BYTES)
    await upload(port, 'sess-b', 'notes.txt', TEXT_BYTES)

    const flat = await fetchFlat()
    const ids = new Set(flat.map(entry => entry.sessionId))
    expect(ids.has('sess-a')).toBe(true)
    expect(ids.has('sess-b')).toBe(true)
    // Uploads persist under a content-hash prefix; match by suffix.
    const png = flat.find(entry => entry.name.endsWith('shot.png'))
    const txt = flat.find(entry => entry.name.endsWith('notes.txt'))
    expect(png?.kind).toBe('image')
    expect(png?.sizeBytes).toBe(PNG_BYTES.length)
    expect(txt?.kind).toBe('text')
  })

  it('filters by q substring client-transparently', async () => {
    const handle = await startDomain([{ id: 'sess-a', cwd: cwdA }])
    port = handle.port
    closeServer = () => handle.close()
    await upload(port, 'sess-a', 'alpha.txt', TEXT_BYTES)
    await upload(port, 'sess-a', 'beta.txt', TEXT_BYTES)

    const hit = await rawRequest(agent, port, {
      method: 'GET',
      path: '/api/filehub/library?q=alp',
    })
    const hitBody = JSON.parse(hit.text) as { sessions: Array<{ entries: Array<{ name: string }> }> }
    const names = hitBody.sessions.flatMap(session => session.entries.map(entry => entry.name))
    expect(names).toHaveLength(1)
    expect(names[0]?.endsWith('alpha.txt')).toBe(true)
  })

  it('backfills a session directory that exists on disk without meta rows, exactly once per cache lifetime', async () => {
    // Session registered with the host, file placed manually (no upload → no meta).
    const handle = await startDomain([{ id: 'sess-orphan', cwd: cwdA }])
    port = handle.port
    closeServer = () => handle.close()
    const orphanDir = path.join(cwdA, '.filehub', 'manual')
    await fsp.mkdir(orphanDir, { recursive: true })
    await fsp.writeFile(path.join(orphanDir, 'stray.txt'), 'orphan bytes')

    const first = await rawRequest(agent, port, { method: 'GET', path: '/api/filehub/library' })
    const firstBody = JSON.parse(first.text) as {
      sessions: Array<{ sessionId: string; entries: Array<{ name: string; sizeBytes: number }> }>
    }
    const firstNames = firstBody.sessions.flatMap(s => s.entries.map(e => e.name))
    expect(firstNames).toContain('stray.txt')

    // Second request still lists it — the backfill persisted into meta.
    const second = await rawRequest(agent, port, { method: 'GET', path: '/api/filehub/library?q=stray' })
    const secondBody = JSON.parse(second.text) as {
      sessions: Array<{ entries: Array<{ name: string }> }>
    }
    expect(secondBody.sessions[0]?.entries[0]?.name).toBe('stray.txt')

    // A brand-new file appearing later is NOT picked up again (one-shot scan),
    // proving the scan is stamped rather than repeated every request.
    await fsp.writeFile(path.join(orphanDir, 'later.txt'), 'later bytes')
    const third = await rawRequest(agent, port, { method: 'GET', path: '/api/filehub/library' })
    const thirdBody = JSON.parse(third.text) as { sessions: Array<{ entries: Array<{ name: string }> }> }
    const thirdNames = thirdBody.sessions.flatMap(s => s.entries.map(e => e.name))
    expect(thirdNames).toContain('stray.txt')
    expect(thirdNames).not.toContain('later.txt')
  })

  it('reports truncated when the aggregation ceiling is hit', async () => {
    const handle = await startDomain([{ id: 'sess-a', cwd: cwdA }], {
      console: { maxEntries: 1 },
    })
    port = handle.port
    closeServer = () => handle.close()
    await upload(port, 'sess-a', 'one.txt', TEXT_BYTES)
    await upload(port, 'sess-a', 'two.txt', TEXT_BYTES)

    const response = await rawRequest(agent, port, { method: 'GET', path: '/api/filehub/library' })
    const body = JSON.parse(response.text) as {
      truncated: boolean
      sessions: Array<{ entries: unknown[] }>
    }
    expect(body.truncated).toBe(true)
    expect(body.sessions[0]?.entries.length).toBe(1)
  })
})

describe('GET /api/filehub/usage', () => {
  it('buckets storage by sniffed kind and ranks sessions by bytes', async () => {
    const handle = await startDomain([
      { id: 'sess-a', cwd: cwdA },
      { id: 'sess-b', cwd: cwdB },
    ])
    port = handle.port
    closeServer = () => handle.close()
    await upload(port, 'sess-a', 'pic.png', PNG_BYTES)
    await upload(port, 'sess-b', 'doc.pdf', PDF_BYTES)
    await upload(port, 'sess-b', 'plain.txt', TEXT_BYTES)

    const response = await rawRequest(agent, port, { method: 'GET', path: '/api/filehub/usage' })
    expect(response.status).toBe(200)
    const body = JSON.parse(response.text) as {
      totalBytes: number
      files: number
      byKind: Record<string, { files: number; bytes: number }>
      bySession: Array<{ sessionId: string; bytes: number }>
    }
    expect(body.files).toBe(3)
    expect(body.byKind.image!.files).toBe(1)
    expect(body.byKind.image!.bytes).toBe(PNG_BYTES.length)
    expect(body.byKind.document!.files).toBe(1) // pdf refines to document
    expect(body.byKind.document!.bytes).toBe(PDF_BYTES.length)
    expect(body.byKind.text!.files).toBe(1)
    expect(body.totalBytes).toBe(PNG_BYTES.length + PDF_BYTES.length + TEXT_BYTES.length)
    // sess-b holds two files → strictly more bytes than sess-a.
    expect(body.bySession[0]?.sessionId).toBe('sess-b')
    expect(body.bySession.map(row => row.sessionId)).toContain('sess-a')
  })
})

describe('DELETE /api/filehub/session/:sessionId', () => {
  it('removes one session’s files with containment, leaving others intact, and is idempotent', async () => {
    const handle = await startDomain([
      { id: 'sess-a', cwd: cwdA },
      { id: 'sess-b', cwd: cwdB },
    ])
    port = handle.port
    closeServer = () => handle.close()
    await upload(port, 'sess-a', 'kill-me.txt', TEXT_BYTES)
    await upload(port, 'sess-a', 'nested.txt', TEXT_BYTES, 'sub/nested.txt')
    await upload(port, 'sess-b', 'keep-me.txt', TEXT_BYTES)

    const flat = await fetchFlat()
    const pathsA = flat.filter(entry => entry.sessionId === 'sess-a').map(entry => entry.path)
    const pathB = flat.find(entry => entry.sessionId === 'sess-b')?.path
    expect(pathsA).toHaveLength(2)
    expect(pathB).toBeDefined()

    const response = await rawRequest(agent, port, {
      method: 'DELETE',
      path: '/api/filehub/session/sess-a',
    })
    expect(response.status).toBe(200)
    const body = JSON.parse(response.text) as { deleted: number; freedBytes: number }
    expect(body.deleted).toBe(2)

    for (const target of pathsA) {
      await expect(fsp.access(target)).rejects.toThrow()
    }
    // Empty parent chain pruned, workspace root kept.
    await expect(fsp.access(path.join(cwdA, '.filehub'))).resolves.toBeUndefined()
    if (pathB !== undefined) {
      await expect(fsp.access(pathB)).resolves.toBeUndefined()
    }

    // Idempotent repeat: nothing left, still a success answer.
    const repeat = await rawRequest(agent, port, {
      method: 'DELETE',
      path: '/api/filehub/session/sess-a',
    })
    expect(repeat.status).toBe(200)
    expect(JSON.parse(repeat.text)).toMatchObject({ deleted: 0, freedBytes: 0 })
  })

  it('answers 400 for malformed session ids (containment gate)', async () => {
    const handle = await startDomain([{ id: 'sess-a', cwd: cwdA }])
    port = handle.port
    closeServer = () => handle.close()
    const response = await rawRequest(agent, port, {
      method: 'DELETE',
      path: `/api/filehub/session/${encodeURIComponent('../escape')}`,
    })
    expect(response.status).toBe(400)
  })

  it('cleans up metadata so deleted files vanish from the library', async () => {
    const handle = await startDomain([{ id: 'sess-a', cwd: cwdA }])
    port = handle.port
    closeServer = () => handle.close()
    await upload(port, 'sess-a', 'gone.txt', TEXT_BYTES)
    await rawRequest(agent, port, { method: 'DELETE', path: '/api/filehub/session/sess-a' })
    const library = await rawRequest(agent, port, { method: 'GET', path: '/api/filehub/library' })
    const body = JSON.parse(library.text) as { sessions: unknown[] }
    expect(body.sessions).toHaveLength(0)
  })
})

describe('POST /api/filehub/cleanup (two-step)', () => {
  it('dryRun counts without deleting, then execute deletes the same set', async () => {
    const handle = await startDomain([
      { id: 'sess-a', cwd: cwdA },
      { id: 'sess-b', cwd: cwdB },
    ])
    port = handle.port
    closeServer = () => handle.close()
    await upload(port, 'sess-a', 'old-one.txt', TEXT_BYTES)
    await upload(port, 'sess-b', 'old-two.png', PNG_BYTES)

    const before = await fetchFlat()
    expect(before).toHaveLength(2)
    const totalExpected = TEXT_BYTES.length + PNG_BYTES.length

    const preview = await rawRequest(agent, port, {
      method: 'POST',
      path: '/api/filehub/cleanup',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(Buffer.from(JSON.stringify({ scope: 'expired', ttlMs: 1, dryRun: true }))),
    })
    expect(preview.status).toBe(200)
    const previewBody = JSON.parse(preview.text) as {
      dryRun: boolean
      wouldDelete: number
      deleted: number
      wouldFreeBytes: number
      freedBytes: number
    }
    expect(previewBody.dryRun).toBe(true)
    expect(previewBody.wouldDelete).toBe(2)
    expect(previewBody.deleted).toBe(0)
    expect(previewBody.wouldFreeBytes).toBe(totalExpected)

    // Nothing was removed by the preview.
    for (const entry of before) {
      await expect(fsp.access(entry.path)).resolves.toBeUndefined()
    }

    const execute = await rawRequest(agent, port, {
      method: 'POST',
      path: '/api/filehub/cleanup',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(Buffer.from(JSON.stringify({ scope: 'expired', ttlMs: 1, dryRun: false }))),
    })
    expect(execute.status).toBe(200)
    const executeBody = JSON.parse(execute.text) as { deleted: number; freedBytes: number }
    expect(executeBody.deleted).toBe(2)
    expect(executeBody.freedBytes).toBe(totalExpected)
    for (const entry of before) {
      await expect(fsp.access(entry.path)).rejects.toThrow()
    }

    const secondPreview = await rawRequest(agent, port, {
      method: 'POST',
      path: '/api/filehub/cleanup',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(Buffer.from(JSON.stringify({ scope: 'expired', ttlMs: 1, dryRun: true }))),
    })
    expect(JSON.parse(secondPreview.text)).toMatchObject({ wouldDelete: 0 })
  })

  it('scopes "session" to one session only and requires sessionId', async () => {
    const handle = await startDomain([
      { id: 'sess-a', cwd: cwdA },
      { id: 'sess-b', cwd: cwdB },
    ])
    port = handle.port
    closeServer = () => handle.close()
    await upload(port, 'sess-a', 'mine.txt', TEXT_BYTES)
    await upload(port, 'sess-b', 'theirs.txt', TEXT_BYTES)

    const missingId = await rawRequest(agent, port, {
      method: 'POST',
      path: '/api/filehub/cleanup',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(Buffer.from(JSON.stringify({ scope: 'session', dryRun: false }))),
    })
    expect(missingId.status).toBe(400)

    const flat = await fetchFlat()
    const minePath = flat.find(entry => entry.sessionId === 'sess-a')?.path
    const theirsPath = flat.find(entry => entry.sessionId === 'sess-b')?.path

    const execute = await rawRequest(agent, port, {
      method: 'POST',
      path: '/api/filehub/cleanup',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(
        Buffer.from(JSON.stringify({ scope: 'session', sessionId: 'sess-a', dryRun: false })),
      ),
    })
    expect(execute.status).toBe(200)
    expect(JSON.parse(execute.text)).toMatchObject({ deleted: 1 })
    if (minePath !== undefined) await expect(fsp.access(minePath)).rejects.toThrow()
    if (theirsPath !== undefined) await expect(fsp.access(theirsPath)).resolves.toBeUndefined()
  })

  it('answers 400 for invalid bodies', async () => {
    const handle = await startDomain([{ id: 'sess-a', cwd: cwdA }])
    port = handle.port
    closeServer = () => handle.close()
    const badScope = await rawRequest(agent, port, {
      method: 'POST',
      path: '/api/filehub/cleanup',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(Buffer.from(JSON.stringify({ scope: 'everything' }))),
    })
    expect(badScope.status).toBe(400)

    const badJson = await rawRequest(agent, port, {
      method: 'POST',
      path: '/api/filehub/cleanup',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(Buffer.from('{nope')),
    })
    expect(badJson.status).toBe(400)
  })
})
