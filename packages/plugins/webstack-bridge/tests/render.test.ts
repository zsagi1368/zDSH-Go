/**
 * 渲染编排测试：SeamBridgeRuntime 同形面 + 串行排队 + ACK 纪律 + SSRF 注入闸。
 * 全离线：SSRF 校验器用注入替身；WS 往返走 127.0.0.1 随机端口。
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import { BridgeRenderer, type CheckTargetFn } from '../src/render.ts'
import { type Frame, type Harness, pair, send, startServer } from './helpers.ts'

const harnesses: Harness[] = []
const sockets: WebSocket[] = []

afterAll(async () => {
  for (const ws of sockets) ws.terminate()
  for (const harness of harnesses) await harness.server.stop()
})

async function boot(): Promise<Harness> {
  const harness = await startServer()
  harnesses.push(harness)
  return harness
}

const allowAll: CheckTargetFn = async () => ({ allowed: true })

/** 受控客户端：记录全部入站 render-req，回包由用例显式驱动。 */
interface Controlled {
  ws: WebSocket
  readonly requests: readonly Frame[]
  reply(
    req: Frame,
    overrides?: Partial<{ ok: boolean; content: string; statusCode: number }>,
  ): void
}

async function controlled(harness: Harness): Promise<Controlled> {
  const { ws } = await pair(harness)
  sockets.push(ws)
  const requests: Frame[] = []
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data)) as Frame
    if (frame.type === 'render-req') requests.push(frame)
  })
  return {
    ws,
    requests,
    reply(req, overrides = {}) {
      send(ws, {
        type: 'render-res',
        id: req.id,
        ok: true,
        content: `content-of:${String(req.url)}`,
        statusCode: 200,
        ...overrides,
      })
    },
  }
}

describe('渲染往返与超时语义', () => {
  it('render 往返：render-req 携带 url/timeoutMs/整数 id，响应回显该 id 并结算结果', async () => {
    const harness = await boot()
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: allowAll })
    const client = await controlled(harness)

    const pending = renderer.render('https://target.example/page', 1000)
    await waitFor(() => client.requests.length === 1)
    const req = client.requests[0]!
    expect(req.url).toBe('https://target.example/page')
    expect(req.timeoutMs).toBe(1000)
    expect(Number.isInteger(req.id)).toBe(true)

    client.reply(req)
    expect(await pending).toEqual({
      content: 'content-of:https://target.example/page',
      statusCode: 200,
    })
  })

  it('ACK 纪律：同连接上连续渲染的出站 id 单调递增且响应逐一回显', async () => {
    const harness = await boot()
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: allowAll })
    const client = await controlled(harness)

    const first = renderer.render('https://seq.example/1', 800)
    await waitFor(() => client.requests.length === 1)
    client.reply(client.requests[0]!)
    await first

    const second = renderer.render('https://seq.example/2', 800)
    await waitFor(() => client.requests.length === 2)
    client.reply(client.requests[1]!)
    expect(await second).toBeDefined()

    const id1 = Number(client.requests[0]!.id)
    const id2 = Number(client.requests[1]!.id)
    expect(id2).toBeGreaterThan(id1)
  })

  it('对端沉默：timeoutMs 后返回 undefined', async () => {
    const harness = await boot()
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: allowAll })
    await controlled(harness) // 客户端在位但永不回包
    const startedAt = Date.now()
    expect(await renderer.render('https://slow.example/x', 80)).toBeUndefined()
    expect(Date.now() - startedAt).toBeLessThan(1500)
  })

  it('无已配对连接时立即返回 undefined（不等待超时）', async () => {
    const harness = await boot()
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: allowAll })
    const startedAt = Date.now()
    expect(await renderer.render('https://nobody.example/', 500)).toBeUndefined()
    expect(Date.now() - startedAt).toBeLessThan(200)
  })

  it('ok=false 的 render-res 归结为 undefined', async () => {
    const harness = await boot()
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: allowAll })
    const client = await controlled(harness)
    const pending = renderer.render('https://fail.example/', 800)
    await waitFor(() => client.requests.length === 1)
    client.reply(client.requests[0]!, { ok: false })
    expect(await pending).toBeUndefined()
  })

  it('错误 id 的 render-res 被忽略，原请求照常超时（不结算、不串包）', async () => {
    const harness = await boot()
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: allowAll })
    const client = await controlled(harness)
    const pending = renderer.render('https://late.example/', 120)
    await waitFor(() => client.requests.length === 1)
    send(client.ws, {
      type: 'render-res',
      id: Number(client.requests[0]!.id) + 10_000,
      ok: true,
      content: 'spoof',
      statusCode: 200,
    })
    expect(await pending).toBeUndefined()
  })

  it('断连中途：在途渲染以 undefined 结算并触发 onDisconnect', async () => {
    const harness = await boot()
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: allowAll })
    let disconnected = false
    renderer.onDisconnect(() => {
      disconnected = true
    })
    const client = await controlled(harness)
    const pending = renderer.render('https://drop.example/', 3000)
    await waitFor(() => client.requests.length === 1)
    client.ws.close()
    expect(await pending).toBeUndefined()
    await waitFor(() => disconnected)
    expect(harness.server.isConnected()).toBe(false)
  })
})

describe('并发排队与 fail-closed', () => {
  it('串行排队：前一请求未结算时不出站下一请求；到达顺序即调用顺序', async () => {
    const harness = await boot()
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: allowAll })
    const client = await controlled(harness)

    const p1 = renderer.render('https://q.example/1', 900)
    const p2 = renderer.render('https://q.example/2', 900)
    const p3 = renderer.render('https://q.example/3', 900)

    await waitFor(() => client.requests.length === 1)
    await sleep(40)
    expect(client.requests).toHaveLength(1) // 串行：第一个未结算前第二个绝不出站

    client.reply(client.requests[0]!)
    expect(await p1).toBeDefined()
    await waitFor(() => client.requests.length === 2)
    client.reply(client.requests[1]!)
    expect(await p2).toBeDefined()
    await waitFor(() => client.requests.length === 3)
    client.reply(client.requests[2]!)
    expect(await p3).toBeDefined()

    expect(client.requests.map(frame => frame.url)).toEqual([
      'https://q.example/1',
      'https://q.example/2',
      'https://q.example/3',
    ])
  })

  it('SSRF 注入闸拒绝路径：allowed=false 不出站任何帧、直接 undefined', async () => {
    const harness = await boot()
    const rejectLoopback: CheckTargetFn = async () => ({ allowed: false })
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: rejectLoopback })
    const client = await controlled(harness)
    expect(await renderer.render('http://127.0.0.1:8080/admin', 500)).toBeUndefined()
    await sleep(50)
    expect(client.requests).toHaveLength(0)
  })

  it('checkTarget 抛错（DNS 故障等）按 fail-closed 归并为 undefined', async () => {
    const harness = await boot()
    const exploding: CheckTargetFn = async () => {
      throw new Error('dns boom')
    }
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: exploding })
    const client = await controlled(harness)
    expect(await renderer.render('https://dns-broken.example/', 500)).toBeUndefined()
    expect(client.requests).toHaveLength(0)
  })

  it('闸未装配时整体 fail-closed；setTargetChecker 后置注入即恢复', async () => {
    const harness = await boot()
    const renderer = new BridgeRenderer({ server: harness.server })
    const client = await controlled(harness)
    expect(renderer.online).toBe(true)

    expect(await renderer.render('https://unchecked.example/', 300)).toBeUndefined()
    await sleep(60)
    expect(client.requests).toHaveLength(0)

    renderer.setTargetChecker(allowAll)
    const pending = renderer.render('https://now-checked.example/', 600)
    await waitFor(() => client.requests.length === 1)
    client.reply(client.requests[0]!, { content: 'c' })
    expect(await pending).toEqual({ content: 'c', statusCode: 200 })
  })

  it('SSRF 校验先于排队执行：被拒目标不占用浏览器串行槽位', async () => {
    const harness = await boot()
    let verdicts = 0
    const counting: CheckTargetFn = async (url) => {
      verdicts += 1
      return { allowed: !url.startsWith('https://blocked.example') }
    }
    const renderer = new BridgeRenderer({ server: harness.server, checkTarget: counting })
    const client = await controlled(harness)
    // 首个任务被闸拒绝（不出站），后续合法任务无需等它
    const rejected = renderer.render('https://blocked.example/a', 500)
    const accepted = renderer.render('https://fine.example/b', 500)
    expect(await rejected).toBeUndefined()
    await waitFor(() => client.requests.length === 1)
    client.reply(client.requests[0]!)
    expect(await accepted).toBeDefined()
    expect(verdicts).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// 局部工具
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await sleep(10)
  }
}
