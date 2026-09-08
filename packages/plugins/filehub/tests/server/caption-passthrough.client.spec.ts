/**
 * M6 caption passthrough chain (P01 §6-D FR-D4 + §6-A/§6-E surfaces).
 *
 * The vision waterfall's caption must survive the whole round trip: upload
 * response body → upload metadata KV row (recorded by the wiring layer) →
 * GET /list entries → GET /library entries. The client queue mirrors the wire
 * shape defensively (optional field forwarded only when present).
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  defaultTestConfig,
  makeDomain,
  makeTempDir,
  rawRequest,
  removeTempDir,
  startRouteServer,
  uploadRequest,
} from './helpers.client.js'
import { parseUploadResult, UploadQueue } from '../../src/client/upload/queue.js'
import type { UploadedFileResult } from '../../src/client/upload/queue.js'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7])
const CAPTION = '一只猫坐在垫子上'

/** Real HTTP fake speaking the local Ollama protocol on 127.0.0.1:<ephemeral>. */
async function startFakeOllama(): Promise<{ base: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/tags')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ models: [{ name: 'llava:13b' }] }))
      return
    }
    if ((req.url ?? '').startsWith('/api/generate')) {
      const chunks: Array<Buffer> = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ response: CAPTION }))
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() =>{  resolve() })),
  }
}

let cwd: string
let closeServer: (() => Promise<void>) | undefined
let disposeDomain: (() => void) | undefined
let ollama: { base: string; close(): Promise<void> } | undefined

beforeEach(async () => {
  cwd = await makeTempDir('caption-chain')
})

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
  disposeDomain?.()
  disposeDomain = undefined
  await ollama?.close()
  ollama = undefined
  await removeTempDir(cwd)
})

describe('caption passthrough: server chain', () => {
  it('upload response → meta KV → /list and /library all carry imageCaption', async () => {
    ollama = await startFakeOllama()
    const { domain, route } = makeDomain([{ id: 'cap-1', cwd }], {
      ...defaultTestConfig(),
      vision: { ollamaEndpoint: ollama.base },
    })
    disposeDomain = () => { domain.dispose() }
    const server = await startRouteServer(route)
    closeServer = () => server.close()

    // 1. Upload an image: the 200 body carries the caption…
    const up = await uploadRequest(new http.Agent({ keepAlive: false }), server.port, {
      sessionId: 'cap-1',
      fileName: 'cat.png',
      body: PNG_BYTES,
    })
    expect(up.status).toBe(200)
    const uploaded = JSON.parse(up.text) as { imageCaption?: string }
    expect(uploaded.imageCaption).toBe(CAPTION)

    // 2. …GET /list surfaces it from the metadata row…
    const listRes = await rawRequest(new http.Agent({ keepAlive: false }), server.port, {
      method: 'GET',
      path: '/api/filehub/list?sessionId=cap-1',
    })
    expect(listRes.status).toBe(200)
    const listBody = JSON.parse(listRes.text) as {
      entries: Array<{ relativePath: string; imageCaption?: string }>
    }
    const listedImage = listBody.entries.find(entry => entry.relativePath.includes('cat.png'))
    expect(listedImage).toBeDefined()
    expect(listedImage?.imageCaption).toBe(CAPTION)

    // 3. …and GET /library carries it too (cross-session aggregate).
    const libRes = await rawRequest(new http.Agent({ keepAlive: false }), server.port, {
      method: 'GET',
      path: '/api/filehub/library',
    })
    expect(libRes.status).toBe(200)
    const library = JSON.parse(libRes.text) as {
      sessions: Array<{ entries: Array<{ name: string; imageCaption?: string }> }>
    }
    const libraryEntry = library.sessions
      .flatMap(group => group.entries)
      .find(entry => entry.name.includes('cat.png'))
    expect(libraryEntry?.imageCaption).toBe(CAPTION)

    // 4. Re-listing after self-heal stats stays stable (row survived stat check).
    const listAgain = await rawRequest(new http.Agent({ keepAlive: false }), server.port, {
      method: 'GET',
      path: '/api/filehub/list?sessionId=cap-1',
    })
    expect(listAgain.text).toContain('cat.png')
    expect(listAgain.text).toContain(CAPTION)
  })

  it('text uploads carry no caption on any surface', async () => {
    ollama = await startFakeOllama()
    const { domain, route } = makeDomain([{ id: 'cap-2', cwd }], {
      ...defaultTestConfig(),
      vision: { ollamaEndpoint: ollama.base },
    })
    disposeDomain = () => { domain.dispose() }
    const server = await startRouteServer(route)
    closeServer = () => server.close()
    await uploadRequest(new http.Agent({ keepAlive: false }), server.port, {
      sessionId: 'cap-2',
      fileName: 'notes.txt',
      body: new Uint8Array(Buffer.from('plain text')),
    })
    for (const pathAndQuery of [
      '/api/filehub/list?sessionId=cap-2',
      '/api/filehub/library',
    ]) {
      const res = await rawRequest(new http.Agent({ keepAlive: false }), server.port, {
        method: 'GET',
        path: pathAndQuery,
      })
      expect(res.status).toBe(200)
      expect(res.text).not.toContain('imageCaption')
    }
  })
})

describe('caption passthrough: client queue defensive forwarding', () => {
  function makeQueue(result: Record<string, unknown>): UploadQueue {
    return new UploadQueue({
      sessionId: () => 's1',
      transport: async () => result as unknown as UploadedFileResult,
    })
  }

  it('forwards imageCaption when the server attached one', async () => {
    const queue = makeQueue({
      path: '/w/.filehub/s/pic.png',
      relativePath: 'pic.png',
      sniffedType: 'image/png',
      label: 'pic.png',
      imageCaption: CAPTION,
    })
    queue.enqueue([{
      file: new File([new Uint8Array(4)], 'pic.png'),
      relativePath: '',
    }])
    await new Promise(resolve => setTimeout(resolve, 0))
    const item = queue.getItems()[0]
    expect(item?.status).toBe('done')
    expect(item?.result?.imageCaption).toBe(CAPTION)
  })

  it('omits the field entirely when the server did not attach one', async () => {
    const queue = makeQueue({
      path: '/w/.filehub/s/doc.txt',
      relativePath: 'doc.txt',
      sniffedType: 'text/plain',
      label: 'doc.txt',
    })
    queue.enqueue([{
      file: new File([new Uint8Array(4)], 'doc.txt'),
      relativePath: '',
    }])
    await new Promise(resolve => setTimeout(resolve, 0))
    const item = queue.getItems()[0]
    expect(item?.status).toBe('done')
    expect(item?.result).toBeDefined()
    expect('imageCaption' in (item?.result ?? {})).toBe(false)
  })

  it('parseUploadResult ignores a non-string imageCaption instead of trusting hostile wire data', () => {
    const result = parseUploadResult(
      200,
      JSON.stringify({
        path: '/w/x',
        relativePath: 'x',
        sniffedType: 'text/plain',
        label: 'x',
        imageCaption: { evil: 'object-not-a-caption' },
      }),
    )
    expect(result.imageCaption).toBeUndefined()
    // A numeric spoof is equally ignored.
    const numeric = parseUploadResult(
      200,
      JSON.stringify({
        path: '/w/x',
        relativePath: 'x',
        sniffedType: 'text/plain',
        label: 'x',
        imageCaption: 42,
      }),
    )
    expect(numeric.imageCaption).toBeUndefined()
  })
})
