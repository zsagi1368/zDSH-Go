/**
 * Shared test environment for the server suites: fake host context injection
 * (the sanctioned paradigm) plus a REAL node:http server wrapping whatever
 * route the fake `webServer` captured, so every assertion runs over actual
 * HTTP on an OS-assigned port.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createFileHubDomain } from '../../src/index.js'
import type { FileHubConfig } from '../../src/index.js'

// ---- Temporary trees (Windows-safe removal with handle-release retries) -----

export async function makeTempDir(label: string): Promise<string> {
  const root = path.join(os.tmpdir(), `filehub-${label}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  await fsp.mkdir(root, { recursive: true })
  return root
}

export async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      return
    } catch {
      // Windows keeps handles briefly after server/socket close; back off.
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
    }
  }
}

// ---- Fake host context ------------------------------------------------------

export interface FakeSessionSpec {
  id: string
  cwd: string
}

export interface RecordedLogs {
  info: string[]
  warn: string[]
  error: string[]
}

export interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
}

export interface FakeContext {
  ctx: Parameters<typeof createFileHubDomain>[0]
  logs: RecordedLogs
  routes: CapturedRoute[]
  sessions: FakeSessionSpec[]
}

export function makeFakeContext(sessionSpecs: FakeSessionSpec[]): FakeContext {
  const logs: RecordedLogs = { info: [], warn: [], error: [] }
  const routes: CapturedRoute[] = []
  const sessions = sessionSpecs.map(spec => ({ ...spec }))
  const ctx = {
    logger: {
      info: (message: string): void => {
        logs.info.push(message)
      },
      warn: (message: string): void => {
        logs.warn.push(message)
      },
      error: (message: string): void => {
        logs.error.push(message)
      },
    },
    sessions: {
      get(id: string) {
        const found = sessions.find(spec => spec.id === id)
        return found ? { id: found.id, header: { cwd: found.cwd } } : undefined
      },
      list() {
        return sessions.map(spec => ({ id: spec.id, header: { cwd: spec.cwd } }))
      },
    },
    webServer: {
      register(route: CapturedRoute): () => void {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
  return { ctx, logs, routes, sessions }
}

export function defaultTestConfig(): Partial<FileHubConfig> {
  return {
    upload: {
      maxBytes: 64 * 1024,
      maxConcurrent: 4,
      perSessionQuotaBytes: 4 * 1024,
    },
    lifecycle: {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 60 * 60 * 1000,
    },
  }
}

/** Build a domain over a fake context and capture the registered prefix route. */
export function makeDomain(
  sessionSpecs: FakeSessionSpec[],
  config?: Partial<FileHubConfig>,
): { domain: ReturnType<typeof createFileHubDomain>; route: CapturedRoute; logs: RecordedLogs } {
  const fake = makeFakeContext(sessionSpecs)
  const domain = createFileHubDomain(fake.ctx, config ?? defaultTestConfig())
  const route = fake.routes[0]
  if (!route) throw new Error('fake webServer captured no route')
  return { domain, route, logs: fake.logs }
}

// ---- Real HTTP server over the captured route -------------------------------

export interface RouteServerOptions {
  /** Spoof req.socket.remoteAddress for every connection (guard testing). */
  remoteAddressOverride?: string
}

export interface RunningServer {
  port: number
  close(): Promise<void>
}

export async function startRouteServer(
  route: CapturedRoute,
  options: RouteServerOptions = {},
): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    void Promise.resolve()
      .then(() => route.handler(req, res))
      .catch(() => {
        if (!res.writableEnded) {
          res.statusCode = 500
          res.end()
        }
      })
  })
  if (options.remoteAddressOverride !== undefined) {
    server.on('connection', (socket) => {
      Object.defineProperty(socket, 'remoteAddress', { value: options.remoteAddressOverride })
    })
  }
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
        server.closeAllConnections?.()
      }),
  }
}

// ---- Raw HTTP request helpers ------------------------------------------------

export interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
  text: string
  /** True when the client agent reused an existing keep-alive socket. */
  reusedSocket: boolean
}

export interface RawRequestSpec {
  method: string
  path: string
  headers?: Record<string, string | undefined>
  body?: Uint8Array
  /** Write the body in delayed chunks without Content-Length (chunked). */
  slowBody?: { chunks: Array<Uint8Array>; delayMs: number }
}

interface RequestHandle {
  done: Promise<RawResponse>
  write(chunk: Uint8Array): void
  end(finalChunk?: Uint8Array): void
}

export function sendRequest(
  agent: http.Agent,
  port: number,
  spec: RawRequestSpec,
): RequestHandle {
  const headers: Record<string, string | undefined> = { ...spec.headers }
  let req: http.ClientRequest
  if (spec.slowBody !== undefined) {
    // No content-length header → node switches to chunked transfer encoding.
    delete headers['content-length']
    req = http.request({ host: '127.0.0.1', port, method: spec.method, path: spec.path, headers, agent })
  } else {
    req = http.request({ host: '127.0.0.1', port, method: spec.method, path: spec.path, headers, agent })
  }
  const chunks: Array<Buffer> = []
  const done = new Promise<RawResponse>((resolve, reject) => {
    req.on('response', (res) => {
      // Public ClientRequest flag: true when this request rode an existing
      // keep-alive socket (the 413-drain reusability assertion).
      const reused =  req.reusedSocket
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          text: body.toString('utf8'),
          reusedSocket: reused,
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
  })

  // Slow-body mode: drip the declared chunks with delays (no Content-Length →
  // chunked transfer encoding). handle.end() becomes a no-op; the schedule
  // owns the request lifecycle.
  let scheduled = false
  if (spec.slowBody !== undefined) {
    scheduled = true
    const stream = spec.slowBody.chunks
    let index = 0
    const timer = setInterval(() => {
      if (index >= stream.length) {
        clearInterval(timer)
        req.end()
        return
      }
      const chunk = stream[index]
      index += 1
      req.write(Buffer.from(chunk!))
    }, Math.max(1, spec.slowBody.delayMs))
    timer.unref?.()
  }

  return {
    done,
    write(chunk: Uint8Array): void {
      req.write(Buffer.from(chunk))
    },
    end(finalChunk?: Uint8Array): void {
      if (scheduled) return
      if (finalChunk !== undefined) req.write(Buffer.from(finalChunk))
      req.end()
    },
  }
}

/** Fire one complete request and await its response. */
export async function rawRequest(
  agent: http.Agent,
  port: number,
  spec: RawRequestSpec,
): Promise<RawResponse> {
  const handle = sendRequest(agent, port, spec)
  handle.end(spec.body)
  return handle.done
}

// ---- Upload-specific conveniences --------------------------------------------

export interface UploadSpec {
  sessionId?: string
  fileName?: string
  relPath?: string
  body?: Uint8Array
  origin?: string
  extraHeaders?: Record<string, string | undefined>
}

export function uploadHeaders(spec: UploadSpec): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  if (spec.sessionId !== undefined) headers['x-session-id'] = encodeURIComponent(spec.sessionId)
  if (spec.fileName !== undefined) headers['x-file-name'] = encodeURIComponent(spec.fileName)
  if (spec.relPath !== undefined) headers['x-file-relpath'] = encodeURIComponent(spec.relPath)
  if (spec.origin !== undefined) headers.origin = spec.origin
  for (const [name, value] of Object.entries(spec.extraHeaders ?? {})) headers[name] = value
  return headers
}

export function uploadRequest(
  agent: http.Agent,
  port: number,
  spec: UploadSpec & { body?: Uint8Array },
): Promise<RawResponse> {
  return rawRequest(agent, port, {
    method: 'POST',
    path: '/api/filehub/upload',
    headers: uploadHeaders(spec),
    ...(spec.body !== undefined ? { body: spec.body } : {}),
  })
}
