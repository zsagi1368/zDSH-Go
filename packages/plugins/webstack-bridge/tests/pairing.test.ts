/**
 * 配对协议（W-B-58）黑盒测试：真 ws 客户端 ↔ 127.0.0.1 随机端口，全离线。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  CLOSE_AUTH_FAILED,
  CLOSE_PAIR_REJECTED,
  CLOSE_PROTOCOL_VIOLATION,
} from '../src/protocol.ts'
import {
  collectStrings,
  connect,
  expectClose,
  type Harness,
  pair,
  send,
  sha256Hex,
  startServer,
  upgradeStatus,
} from './helpers.ts'

const harnesses: Harness[] = []

async function boot(overrides = {}): Promise<Harness> {
  const harness = await startServer(overrides)
  harnesses.push(harness)
  return harness
}

afterAll(async () => {
  for (const harness of harnesses) await harness.server.stop()
})

describe('配对流：ticket → 长期 key', () => {
  it('有效 ticket 配对成功：paired 帧回显 id 且携带 base64url key', async () => {
    const harness = await boot()
    const ws = await connect(harness.url)
    const ticket = harness.server.issueTicket()
    send(ws, { type: 'pair', id: 42, ticket })
    const reply = await nextFrame(ws)
    expect(reply.type).toBe('paired')
    expect(reply.id).toBe(42)
    const key = reply.key
    expect(typeof key).toBe('string')
    expect((key as string).length).toBeGreaterThanOrEqual(40)
  })

  it('auth 携带配对返回的 key 可重连就绪（render-req 能到达客户端）', async () => {
    const harness = await boot()
    const { ws, key } = await pair(harness)
    ws.close()
    // 新连接走 auth 路径
    const second = await connect(harness.url)
    send(second, { type: 'auth', id: 9, key })
    const ok = await nextFrame(second)
    expect(ok.type).toBe('auth-ok')
    expect(ok.id).toBe(9)
    expect(harness.server.isConnected()).toBe(true)
    // 就绪后 render-req 可达
    const pending = harness.server.requestRender('https://ok.example/a', 500)
    const req = await nextFrame(second)
    expect(req.type).toBe('render-req')
    expect(req.url).toBe('https://ok.example/a')
    send(second, { type: 'render-res', id: req.id, ok: true, content: 'x', statusCode: 200 })
    expect(await pending).toEqual({ content: 'x', statusCode: 200 })
  })

  it('过期 ticket 拒绝并断开（4001，不提示重连）', async () => {
    const harness = await boot({ ticketTtlMs: 40 })
    const ws = await connect(harness.url)
    const ticket = harness.server.issueTicket()
    await sleep(90)
    send(ws, { type: 'pair', id: 1, ticket })
    expect(await expectClose(ws)).toBe(CLOSE_PAIR_REJECTED)
  })

  it('ticket 单次消费：同一 ticket 第二条连接被拒（4001）', async () => {
    const harness = await boot()
    const ticket = harness.server.issueTicket()
    const first = await connect(harness.url)
    send(first, { type: 'pair', id: 1, ticket })
    expect((await nextFrame(first)).type).toBe('paired')
    const second = await connect(harness.url)
    send(second, { type: 'pair', id: 1, ticket })
    expect(await expectClose(second)).toBe(CLOSE_PAIR_REJECTED)
  })

  it('格式非法的 ticket 拒绝（4001）', async () => {
    const harness = await boot()
    const ws = await connect(harness.url)
    send(ws, { type: 'pair', id: 1, ticket: 'not-a-real-ticket' })
    expect(await expectClose(ws)).toBe(CLOSE_PAIR_REJECTED)
  })

  it('重新配对轮换 key：旧 key auth 立即失效（4003）', async () => {
    const harness = await boot()
    const first = await pair(harness)
    // 第二次配对覆盖 pairedKeyHash
    const secondPairWs = await connect(harness.url)
    const newTicket = harness.server.issueTicket()
    send(secondPairWs, { type: 'pair', id: 2, ticket: newTicket })
    const fresh = (await nextFrame(secondPairWs)).key as string
    secondPairWs.close()
    // 旧 key 已失效
    const stale = await connect(harness.url)
    send(stale, { type: 'auth', id: 3, key: first.key })
    expect(await expectClose(stale)).toBe(CLOSE_AUTH_FAILED)
    // 新 key 有效
    const freshConn = await connect(harness.url)
    send(freshConn, { type: 'auth', id: 4, key: fresh })
    expect((await nextFrame(freshConn)).type).toBe('auth-ok')
  })
})

describe('认证失败与握手纪律', () => {
  it('错误 key auth 断开（4003）', async () => {
    const harness = await boot()
    await pair(harness)
    const ws = await connect(harness.url)
    send(ws, { type: 'auth', id: 1, key: `${'a'.repeat(43)}wrong` })
    expect(await expectClose(ws)).toBe(CLOSE_AUTH_FAILED)
  })

  it('尚无任何配对时 auth 也断开（4003）', async () => {
    const harness = await boot()
    const ws = await connect(harness.url)
    send(ws, { type: 'auth', id: 1, key: 'nobody-paired-yet' })
    expect(await expectClose(ws)).toBe(CLOSE_AUTH_FAILED)
  })

  it('握手前发送杂讯帧立即断开（4002）', async () => {
    const harness = await boot()
    const ws = await connect(harness.url)
    send(ws, { type: 'render-res', id: 5, ok: true, content: 'noise' })
    expect(await expectClose(ws)).toBe(CLOSE_PROTOCOL_VIOLATION)
  })

  it('缺 ACK 序号的请求帧视为协议违规（4002）', async () => {
    const harness = await boot()
    const ws = await connect(harness.url)
    const ticket = harness.server.issueTicket()
    send(ws, { type: 'pair', ticket }) // 无 id
    expect(await expectClose(ws)).toBe(CLOSE_PROTOCOL_VIOLATION)
  })

  it('非 JSON 帧断开（4002）；就绪后未知类型同样断开', async () => {
    const harness = await boot()
    const raw = await connect(harness.url)
    raw.send('not-json{{{')
    expect(await expectClose(raw)).toBe(CLOSE_PROTOCOL_VIOLATION)

    const { ws } = await pair(harness)
    send(ws, { type: 'mystery', id: 1 })
    expect(await expectClose(ws)).toBe(CLOSE_PROTOCOL_VIOLATION)
  })
})

describe('升级闸与存储卫生', () => {
  it('chrome-extension:// Origin 放行；缺失 Origin 放行（MV3 service worker 取舍）', async () => {
    const harness = await boot()
    const withOrigin = await connect(harness.url) // 默认带扩展 Origin
    expect(withOrigin.readyState).toBe(WebSocket.OPEN)
    const noOrigin = await connect(harness.url, {})
    expect(noOrigin.readyState).toBe(WebSocket.OPEN)
  })

  it('外来 Origin 的升级被 403 拒绝', async () => {
    const harness = await boot()
    const status = await upgradeStatus(harness.url, { origin: 'https://evil.example' })
    expect(status).toBe(403)
    expect(harness.server.isConnected()).toBe(false)
  })

  it('hash-only 存储：服务端对象图内无明文 key / 明文 ticket，只有其 sha256', async () => {
    const harness = await boot()
    const { key } = await pair(harness)
    const ticket = harness.server.issueTicket() // 签发但未消费
    const strings = collectStrings(harness.server)
    expect(strings).not.toContain(key)
    expect(strings).not.toContain(ticket)
    expect(strings).toContain(sha256Hex(key))
    expect(strings).toContain(sha256Hex(ticket))
  })
})

// ---------------------------------------------------------------------------
// 局部工具
// ---------------------------------------------------------------------------

function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(String(data)) as Record<string, unknown>)
      } catch (err) {
        reject(err as Error)
      }
    })
    ws.once('close', () => reject(new Error('connection closed before frame')))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
