/**
 * BridgeServer（W-B-58 宿主侧）：MV3 扩展借真实浏览器会话做渲染兜底的
 * 回环 WS 服务。安全模型四支柱：
 *
 * 1. 只绑 127.0.0.1 随机端口——外网不可达，内网其他用户会话仍是边界；
 * 2. 升级闸：Origin 必须是 `chrome-extension://*` 或**缺失**。取舍说明：
 *    MV3 service worker 发起的 WebSocket 历史上可以不带 Origin 头，强求
 *    Origin 会把合法 SW 客户端一并拒掉；而恶意网页受浏览器同源策略约束
 *    必然带自身 Origin 落入拒绝分支。Sec-Fetch-* 不作硬性要求（非所有
 *    客户端栈都会附带）。真正的访问控制在配对协议层，不在升级头。
 * 3. 配对协议：一次性短时效 ticket（60s、单次消费）换长期 key；明文 key
 *    **只此一次**下发，服务端从此只存 sha256(key)——宿主进程内存/日志/
 *    快照中不存在可复用凭据（W-B-55 同源原则）。ticket 本身同样只存哈希。
 * 4. 心跳看门狗：20s ping / 60s 无 pong 判死（判死粒度滞后至多一个心跳
 *    周期），半开连接不悬挂渲染请求。
 *
 * ACK 纪律：每个请求帧必须携带整数 id，响应原样回显；render-req 的 id 在
 * 服务端全局单调自增，客户端回包 id 不匹配的一律静默忽略（迟到包）。
 *
 * cookie 零落盘宿主：渲染发生在扩展所在的真实浏览器会话里，cookie/
 * localStorage 永不离开浏览器进程；宿主只接收提取后的正文文本。
 *
 * @module webstack-bridge/server
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import {
  CLOSE_AUTH_FAILED,
  CLOSE_PAIR_REJECTED,
  CLOSE_PROTOCOL_VIOLATION,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
  DEFAULT_TICKET_TTL_MS,
} from './protocol.ts'

/** SSRF 裁决的最小结构像（与 dsh-webstack SafetyVerdict 同形，避免跨包类型耦合）。 */
export interface SafetyVerdictLike {
  readonly allowed: boolean
}

/** ticket 工厂签名（装配层注入；默认 crypto 随机 base64url）。 */
export type TicketIssuer = () => string

export interface BridgeServerOptions {
  /** 一次性 ticket 生成器（由装配层注入，便于审计与测试替身）。 */
  readonly issueTicket: TicketIssuer
  /** 监听地址；默认且建议保持 127.0.0.1。 */
  readonly host?: string
  readonly ticketTtlMs?: number
  readonly heartbeatIntervalMs?: number
  readonly pongTimeoutMs?: number
}

interface ResolvedOptions {
  issueTicket: TicketIssuer
  host: string
  ticketTtlMs: number
  heartbeatIntervalMs: number
  pongTimeoutMs: number
}

interface TicketRecord {
  readonly expiresAt: number
  consumed: boolean
}

interface SocketState {
  ready: boolean
  lastPongAt: number
  heartbeatTimer?: ReturnType<typeof setInterval>
}

interface PendingRender {
  readonly socket: WebSocket
  readonly resolve: (value: { content: string; statusCode: number } | undefined) => void
  timer?: ReturnType<typeof setTimeout>
}

export type RenderResult = { content: string; statusCode: number }

/**
 * 回环桥接服务器。生命周期：`start()` → 扩展 pair/auth → `requestRender()`
 * 往返 → `stop()`。断连语义：已认证连接关闭时，在途渲染全部以 undefined
 * 结算并触发 onDisconnect（内核据此降级 site: 搜索）。
 */
export class BridgeServer {
  private readonly opts: ResolvedOptions

  /** 仅在 start() 后赋值；TS-private 保持运行时可枚举以便测试深扫描存储面。 */
  private httpServer: HttpServer
  private readonly wss: WebSocketServer

  /** ticket 只存 sha256(ticket) → 记录；消费即删除。 */
  private readonly tickets = new Map<string, TicketRecord>()
  /** 已配对长期键的唯一哈希；重新配对即轮换（旧 key 立即失效）。 */
  private pairedKeyHash: string | null = null

  private readonly socketStates = new Map<WebSocket, SocketState>()
  private readonly readySockets = new Set<WebSocket>()
  private readonly pendingRenders = new Map<number, PendingRender>()
  private outboundId = 0

  private readonly readyListeners = new Set<() => void>()
  private readonly disconnectListeners = new Set<() => void>()

  private started = false
  private stopped = false

  constructor(options: BridgeServerOptions) {
    this.opts = {
      issueTicket: options.issueTicket,
      host: options.host ?? '127.0.0.1',
      ticketTtlMs: options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      pongTimeoutMs: options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS,
    }
    this.httpServer = createServer((_req, res) => {
      res.writeHead(404, { connection: 'close' })
      res.end()
    })
    this.wss = new WebSocketServer({ noServer: true })
    this.httpServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head)
    })
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 监听 127.0.0.1 随机端口（listen(0)，由内核分配避免冲突）。 */
  async start(): Promise<void> {
    if (this.started || this.stopped) return
    this.started = true
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      this.httpServer.once('error', onError)
      this.httpServer.listen(0, this.opts.host, () => {
        this.httpServer.removeListener('error', onError)
        resolve()
      })
    })
  }

  /** 幂等停止：断连接、结算在途渲染、清票据与定时器、释放端口。 */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const [socket, state] of [...this.socketStates]) {
      this.clearHeartbeat(state)
      try {
        socket.terminate() // 硬关：停机语义优先确定性，不做优雅关闭握手
      } catch {
        // already gone — nothing to salvage
      }
    }
    for (const [id, pending] of [...this.pendingRenders]) {
      this.clearPendingTimer(pending)
      this.pendingRenders.delete(id)
      pending.resolve(undefined)
    }
    this.tickets.clear()
    this.readySockets.clear()
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      this.httpServer.close(done)
      this.wss.close(done)
    })
  }

  /** 随机端口；未启动或已停止后为 undefined。 */
  getPort(): number | undefined {
    const address = this.httpServer.address()
    return typeof address === 'object' && address !== null ? address.port : undefined
  }

  /** 当前是否存在已配对（ready）连接。 */
  isConnected(): boolean {
    return this.readySockets.size > 0
  }

  // -------------------------------------------------------------------------
  // 配对面（W-B-58）
  // -------------------------------------------------------------------------

  /**
   * 签发一次性 ticket：明文经返回值交给装配层（apply 里打进日志），服务端
   * 只落 sha256 哈希与过期时间。
   */
  issueTicket(): string {
    const ticket = this.opts.issueTicket()
    const digest = sha256(ticket)
    this.tickets.set(digest, { expiresAt: Date.now() + this.opts.ticketTtlMs, consumed: false })
    return ticket
  }

  /** 连接就绪（pair 或 auth 成功）回调；返回注销函数。 */
  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener)
    return () => {
      this.readyListeners.delete(listener)
    }
  }

  /** 已认证连接断开回调（内核降级信号）；返回注销函数。 */
  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => {
      this.disconnectListeners.delete(listener)
    }
  }

  // -------------------------------------------------------------------------
  // 渲染通道
  // -------------------------------------------------------------------------

  /**
   * 向当前 ready 连接发 render-req 并等待 render-res；无连接、发送失败、
   * 超时、对端 ok=false、连接中断一律 resolve undefined（调用方降级），
   * 绝不抛错——桥的不可用是「数据」不是异常。
   */
  requestRender(url: string, timeoutMs: number): Promise<RenderResult | undefined> {
    const socket = this.pickReadySocket()
    if (socket === undefined) return Promise.resolve(undefined)
    const id = ++this.outboundId
    const frame = JSON.stringify({ type: 'render-req', id, url, timeoutMs })
    try {
      socket.send(frame)
    } catch {
      return Promise.resolve(undefined)
    }
    return new Promise<RenderResult | undefined>((resolve) => {
      const pending: PendingRender = { socket, resolve }
      pending.timer = setTimeout(
        () => {
          this.pendingRenders.delete(id)
          resolve(undefined)
        },
        Math.max(1, timeoutMs),
      )
      this.pendingRenders.set(id, pending)
    })
  }

  // -------------------------------------------------------------------------
  // 内部：升级闸与连接状态机
  // -------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = req.headers.origin
    // Origin 缺失放行 = MV3 service worker 兼容取舍（见模块头注释 §2）。
    if (origin !== undefined && !origin.startsWith('chrome-extension://')) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.handleConnection(ws)
    })
  }

  private handleConnection(ws: WebSocket): void {
    const state: SocketState = { ready: false, lastPongAt: Date.now() }
    this.socketStates.set(ws, state)
    state.heartbeatTimer = setInterval(() => {
      this.heartbeatTick(ws, state)
    }, this.opts.heartbeatIntervalMs)

    ws.on('pong', () => {
      state.lastPongAt = Date.now()
    })
    ws.on('message', (data) => {
      this.handleMessage(ws, state, data)
    })
    ws.on('close', () => {
      this.handleClose(ws, state)
    })
    ws.on('error', () => {
      // close event follows; keep the process alive either way.
    })
  }

  private heartbeatTick(ws: WebSocket, state: SocketState): void {
    if (Date.now() - state.lastPongAt > this.opts.pongTimeoutMs) {
      ws.terminate() // hard-drop half-open sockets; close handler settles renders
      return
    }
    try {
      ws.ping()
    } catch {
      // send on a dying socket throws synchronously; close will follow.
    }
  }

  private handleClose(ws: WebSocket, state: SocketState): void {
    this.clearHeartbeat(state)
    this.socketStates.delete(ws)
    const wasReady = this.readySockets.delete(ws)
    for (const [id, pending] of [...this.pendingRenders]) {
      if (pending.socket === ws) {
        this.clearPendingTimer(pending)
        this.pendingRenders.delete(id)
        pending.resolve(undefined)
      }
    }
    if (wasReady) {
      for (const listener of [...this.disconnectListeners]) listener()
    }
  }

  private handleMessage(ws: WebSocket, state: SocketState, data: unknown): void {
    let frame: unknown
    try {
      frame = JSON.parse(String(data))
    } catch {
      this.closeWith(ws, CLOSE_PROTOCOL_VIOLATION, 'non-json-frame')
      return
    }
    if (!isRecord(frame)) {
      this.closeWith(ws, CLOSE_PROTOCOL_VIOLATION, 'non-object-frame')
      return
    }
    const id = frame.id
    if (!Number.isInteger(id)) {
      this.closeWith(ws, CLOSE_PROTOCOL_VIOLATION, 'missing-ack-id')
      return
    }

    if (!state.ready) {
      this.handleHandshake(ws, state, frame, id as number)
      return
    }
    this.handleReadyFrame(ws, frame, id as number)
  }

  /** 握手态：只认 pair / auth，其余立即断（不重连提示见 protocol.ts 关闭码注释）。 */
  private handleHandshake(
    ws: WebSocket,
    state: SocketState,
    frame: Record<string, unknown>,
    id: number,
  ): void {
    const type = frame.type
    if (type === 'pair') {
      const ticket = frame.ticket
      if (typeof ticket !== 'string' || !this.consumeTicket(ticket)) {
        this.closeWith(ws, CLOSE_PAIR_REJECTED, 'pair-rejected')
        return
      }
      // 明文 key 只存在于本局部变量与这一次下发帧中；服务端仅存其哈希。
      const key = randomBytes(32).toString('base64url')
      this.pairedKeyHash = sha256(key)
      this.sendJson(ws, { type: 'paired', id, key })
      this.markReady(ws, state)
      return
    }
    if (type === 'auth') {
      const key = frame.key
      const valid =
        typeof key === 'string' &&
        this.pairedKeyHash !== null &&
        timingSafeEq(sha256(key), this.pairedKeyHash)
      if (!valid) {
        this.closeWith(ws, CLOSE_AUTH_FAILED, 'auth-failed')
        return
      }
      this.sendJson(ws, { type: 'auth-ok', id })
      this.markReady(ws, state)
      return
    }
    this.closeWith(ws, CLOSE_PROTOCOL_VIOLATION, 'handshake-required')
  }

  /** 就绪态：只认 render-res；id 不匹配视为迟到包静默忽略。 */
  private handleReadyFrame(ws: WebSocket, frame: Record<string, unknown>, id: number): void {
    if (frame.type !== 'render-res') {
      this.closeWith(ws, CLOSE_PROTOCOL_VIOLATION, 'unknown-type')
      return
    }
    const pending = this.pendingRenders.get(id)
    if (pending === undefined || pending.socket !== ws) return
    this.pendingRenders.delete(id)
    this.clearPendingTimer(pending)
    if (frame.ok === true && typeof frame.content === 'string') {
      const statusCodeRaw = frame.statusCode
      const statusCode =
        typeof statusCodeRaw === 'number' && Number.isInteger(statusCodeRaw) ? statusCodeRaw : 0
      pending.resolve({ content: frame.content, statusCode })
    } else {
      pending.resolve(undefined)
    }
  }

  // -------------------------------------------------------------------------
  // 内部：小工具
  // -------------------------------------------------------------------------

  /** 单次消费校验：存在、未过期、未消费 → 标记消费并从存储删除（哈希不留痕）。 */
  private consumeTicket(ticket: string): boolean {
    const digest = sha256(ticket)
    const record = this.tickets.get(digest)
    if (record === undefined) return false
    this.tickets.delete(digest)
    return !record.consumed && Date.now() <= record.expiresAt
  }

  private markReady(ws: WebSocket, state: SocketState): void {
    state.ready = true
    this.readySockets.add(ws)
    for (const listener of [...this.readyListeners]) listener()
  }

  private pickReadySocket(): WebSocket | undefined {
    for (const socket of this.readySockets) {
      if (socket.readyState === WebSocket.OPEN) return socket
    }
    return undefined
  }

  private sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
    ws.send(JSON.stringify(payload))
  }

  private closeWith(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      ws.terminate()
    }
  }

  private clearHeartbeat(state: SocketState): void {
    if (state.heartbeatTimer !== undefined) {
      clearInterval(state.heartbeatTimer)
      delete state.heartbeatTimer
    }
  }

  private clearPendingTimer(pending: PendingRender): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer)
  }
}

// ---------------------------------------------------------------------------
// 模块级纯函数
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 常数时间十六进制摘要比较（比较的是哈希，长度恒定 64）。 */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
