import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticateWebHost, forwardWebRequest, serveWebDocument } from '../src/web-document.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * One request as Chromium sends it from the application renderer: same-origin
 * GETs carry Fetch Metadata but no `Origin` header.
 * @param url - Application-origin URL.
 * @returns The request the forwarder sees in production for that URL.
 */
function rendererGet(url: string): Request {
  return new Request(url, { headers: { 'sec-fetch-site': 'same-origin' } })
}

it('serves the Web entry and assets without starting or contacting a Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-web-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script src="assets/entry.js"></script></body></html>')
  await writeFile(join(root, 'assets/entry.js'), 'globalThis.entryLoaded = true')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await serveWebDocument(new Request('dsh-app://app/'), root)
  const html = await response.text()
  expect(html.indexOf('Promise.withResolvers()')).toBeLessThan(html.indexOf('assets/entry.js'))
  expect(await (await serveWebDocument(new Request('dsh-app://app/assets/entry.js'), root)).text()).toContain('entryLoaded')
  expect(fetch).not.toHaveBeenCalled()
  expect((await serveWebDocument(new Request('dsh-app://app/%2e%2e%2fprivate'), root)).status).toBe(403)
  expect((await serveWebDocument(new Request('dsh-app://app/missing.js'), root)).status).toBe(404)
})

it('requires the Host authentication exchange and retains only its cookie value', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'session=owned; HttpOnly; SameSite=Strict' } }))
    .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  expect(await authenticateWebHost('http://127.0.0.1:1234/?token=owned')).toBe('session=owned')
  await expect(authenticateWebHost('http://127.0.0.1:1234/')).rejects.toThrow('authentication failed')
})

it('forwards upload bytes and cancellation with Host credentials while keeping the response streaming', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close() } })
  const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-encoding': 'gzip', 'set-cookie': 'private' } }))
  vi.stubGlobal('fetch', fetch)
  const request = new Request('dsh-app://app/api/upload?name=file', {
    method: 'POST', body: 'upload bytes',
    headers: { origin: 'dsh-app://app', 'sec-fetch-site': 'same-origin', cookie: 'untrusted' },
  })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/?token=secret', 'session=owned')
  const [target, init] = fetch.mock.calls[0] as [URL, RequestInit]
  expect(target.href).toBe('http://127.0.0.1:1234/api/upload?name=file')
  expect(new Headers(init.headers).get('cookie')).toBe('session=owned')
  expect(new Headers(init.headers).get('origin')).toBeNull()
  expect(init.signal).toBe(request.signal)
  expect(init.body).toBe(request.body)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(await response.text()).toBe('stream')
})

it('drops connection-level headers the Host wrote for its own transport', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('body', { headers: {
    'transfer-encoding': 'chunked', connection: 'keep-alive', 'keep-alive': 'timeout=5', trailer: 'x', te: 'trailers',
    'content-type': 'text/plain', 'cache-control': 'no-cache', etag: '"1"',
  } }))
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(rendererGet('dsh-app://app/api/read'), 'http://127.0.0.1:1234/', 'session=owned')
  for (const name of ['transfer-encoding', 'connection', 'keep-alive', 'trailer', 'te']) expect(response.headers.get(name)).toBeNull()
  expect(response.headers.get('content-type')).toBe('text/plain')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(response.headers.get('etag')).toBe('"1"')
})

it('replaces the immutable cache header of plugin bundles with no-store and leaves other routes alone', async () => {
  const immutable = 'public, max-age=31536000, immutable'
  const fetch = vi.fn().mockImplementation(async () => new Response('js', { headers: { 'cache-control': immutable } }))
  vi.stubGlobal('fetch', fetch)
  const bundle = await forwardWebRequest(rendererGet('dsh-app://app/plugins/??a/client.js&rev=1'), 'http://127.0.0.1:1234/', 'c')
  expect(bundle.headers.get('cache-control')).toBe('no-store')
  const chunk = await forwardWebRequest(rendererGet('dsh-app://app/plugins/a/client.x.js?rev=1'), 'http://127.0.0.1:1234/', 'c')
  expect(chunk.headers.get('cache-control')).toBe('no-store')
  const asset = await forwardWebRequest(rendererGet('dsh-app://app/api/plugins/list'), 'http://127.0.0.1:1234/', 'c')
  expect(asset.headers.get('cache-control')).toBe(immutable)
})

it('refuses another page origin without forwarding its request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(new Request('dsh-app://app/api/read', { headers: { origin: 'https://other.example' } }), 'http://127.0.0.1:1234/', 'session=owned')
  expect(response.status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})

it('refuses a request with no renderer source signal instead of handing it the Host cookie', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  // Neither `Origin` nor Chromium's Fetch Metadata stamp: native code, a preload,
  // or a foreign document — never a renderer request, so the door fails closed.
  const bare = await forwardWebRequest(new Request('dsh-app://app/api/read'), 'http://127.0.0.1:1234/', 'session=owned')
  expect(bare.status).toBe(403)
  const nullOrigin = await forwardWebRequest(new Request('dsh-app://app/api/read', { headers: { origin: 'null' } }), 'http://127.0.0.1:1234/', 'session=owned')
  expect(nullOrigin.status).toBe(403)
  // A foreign origin cannot borrow the same-origin stamp.
  const foreign = await forwardWebRequest(new Request('dsh-app://app/api/read', {
    headers: { origin: 'https://other.example', 'sec-fetch-site': 'same-origin' },
  }), 'http://127.0.0.1:1234/', 'session=owned')
  expect(foreign.status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})

it('refuses a Host path outside the renderer-consumed prefixes', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  // The Host also answers /oauth/callback and its static fallback; neither is a
  // renderer route, and the prefix boundary keeps look-alikes out.
  for (const path of ['/oauth/callback', '/apix/read', '/apiary', '/pluginsx/a.js']) {
    const response = await forwardWebRequest(rendererGet(`dsh-app://app${path}`), 'http://127.0.0.1:1234/', 'session=owned')
    expect(response.status, path).toBe(403)
  }
  // The prefixes themselves stay forwardable, including the open-in-app panel reads.
  const fetchOk = vi.fn().mockResolvedValue(new Response('ok'))
  vi.stubGlobal('fetch', fetchOk)
  expect((await forwardWebRequest(rendererGet('dsh-app://app/api'), 'http://127.0.0.1:1234/', 'c')).status).toBe(200)
  expect((await forwardWebRequest(rendererGet('dsh-app://app/open-in-app/apps'), 'http://127.0.0.1:1234/', 'c')).status).toBe(200)
  expect(fetch).not.toHaveBeenCalled()
})

it('refuses a pathname a backslash would re-normalize on the Host URL', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('ok'))
  vi.stubGlobal('fetch', fetch)
  // `\` is a literal path character in the `dsh-app:` source, so both paths clear the
  // prefix check; copied onto the `http:` Host URL it acts as a separator, and the
  // target normalizes the `..` away (`/oauth`, `/oauth/callback`) — the path requested
  // from the Host would not be the path this allow list checked.
  for (const url of ['dsh-app://app/api/a\\..\\..\\oauth', 'dsh-app://app/plugins\\..\\oauth/callback']) {
    const response = await forwardWebRequest(rendererGet(url), 'http://127.0.0.1:1234/', 'session=owned')
    expect(response.status, url).toBe(403)
  }
  expect(fetch).not.toHaveBeenCalled()
})
