/**
 * 测试夹具：全部离线——WS 客户端只连本进程刚启动的 127.0.0.1 随机端口。
 * @packageDocumentation
 */
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import net from 'node:net'
import { WebSocket } from 'ws'
import { BridgeServer, type TicketIssuer } from '../src/server.ts'

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export const defaultTicketIssuer: TicketIssuer = () => randomBytes(16).toString('base64url')

export interface Harness {
  server: BridgeServer
  port: number
  url: string
}

export interface HarnessOverrides {
  issueTicket?: TicketIssuer
  ticketTtlMs?: number
  heartbeatIntervalMs?: number
  pongTimeoutMs?: number
}

export async function startServer(overrides: HarnessOverrides = {}): Promise<Harness> {
  const server = new BridgeServer({
    issueTicket: overrides.issueTicket ?? defaultTicketIssuer,
    ...(overrides.ticketTtlMs === undefined ? {} : { ticketTtlMs: overrides.ticketTtlMs }),
    ...(overrides.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: overrides.heartbeatIntervalMs }),
    ...(overrides.pongTimeoutMs === undefined ? {} : { pongTimeoutMs: overrides.pongTimeoutMs }),
  })
  await server.start()
  const port = server.getPort()
  if (port === undefined) throw new Error('server did not report a port')
  return { server, port, url: `ws://127.0.0.1:${port}` }
}

/** 合法 MV3 扩展 Origin（默认客户端头）。 */
export const EXT_ORIGIN = 'chrome-extension://dshwebstackbridge'

export function connect(
  url: string,
  headers: Record<string, string> = { origin: EXT_ORIGIN },
): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers })
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req: unknown, res: unknown) => {
      reject(new Error(`upgrade rejected with ${String((res as IncomingMessage).statusCode)}`))
    })
  })
}

export type Frame = Record<string, unknown>

export function send(ws: WebSocket, frame: object): void {
  ws.send(JSON.stringify(frame))
}

export async function nextMessage(ws: WebSocket): Promise<Frame> {
  const args = (await once(ws, 'message')) as unknown as [Buffer]
  return JSON.parse(args[0].toString('utf8')) as Frame
}

export async function expectClose(ws: WebSocket): Promise<number> {
  const args = (await once(ws, 'close')) as unknown as [number]
  return args[0]
}

/** 拒绝升级场景：捕获 HTTP 状态码（403）。 */
export function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    ws.on('unexpected-response', (_req: unknown, res: unknown) => {
      resolve((res as IncomingMessage).statusCode ?? 0)
      ws.terminate()
    })
    ws.on('open', () => {
      ws.terminate()
      reject(new Error('expected upgrade rejection, got open'))
    })
    ws.on('error', () => {}) // unexpected-response 已给出结论，吞掉伴生 error
  })
}

export async function pair(harness: Harness): Promise<{ ws: WebSocket; key: string }> {
  const ws = await connect(harness.url)
  const ticket = harness.server.issueTicket()
  send(ws, { type: 'pair', id: 1, ticket })
  const reply = await nextMessage(ws)
  if (reply.type !== 'paired') {
    throw new Error(`expected paired frame, got ${String(reply.type)}`)
  }
  return { ws, key: reply.key as string }
}

export async function auth(harness: Harness, key: string): Promise<WebSocket> {
  const ws = await connect(harness.url)
  send(ws, { type: 'auth', id: 7, key })
  const reply = await nextMessage(ws)
  if (reply.type !== 'auth-ok') {
    throw new Error(`expected auth-ok frame, got ${String(reply.type)}`)
  }
  return ws
}

/**
 * 原始 TCP WebSocket 握手（不发 pong、不回消息）：心跳判死路径的黑盒驱动。
 */
export function rawSocketConnect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      const key = randomBytes(16).toString('base64')
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1')
      const headEnd = buffer.indexOf('\r\n\r\n')
      if (headEnd >= 0) {
        socket.off('data', onData)
        if (/^HTTP\/1\.1 101/i.test(buffer)) resolve(socket)
        else reject(new Error(`handshake refused: ${buffer.slice(0, headEnd)}`))
      }
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}

/** 深度收集对象图内全部字符串（含 Map/Set 内部槽；环安全、深度封顶）。 */
export function collectStrings(root: unknown, depth = 0, seen = new Set<object>()): string[] {
  const out: string[] = []
  const walk = (value: unknown, level: number): void => {
    if (level > 10) return
    if (typeof value === 'string') {
      out.push(value)
      return
    }
    if (typeof value !== 'object' || value === null) return
    if (seen.has(value)) return
    seen.add(value)
    if (value instanceof Map) {
      for (const [k, v] of value) {
        walk(k, level + 1)
        walk(v, level + 1)
      }
      return
    }
    if (value instanceof Set) {
      for (const item of value) walk(item, level + 1)
      return
    }
    for (const entry of Object.values(value)) walk(entry, level + 1)
  }
  walk(root, depth)
  return out
}
