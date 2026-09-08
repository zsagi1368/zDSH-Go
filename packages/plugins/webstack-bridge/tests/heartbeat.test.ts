/**
 * 心跳看门狗与生命周期测试：真连接 + 可调短周期，全部离线回环。
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import {
  connect,
  type Harness,
  nextMessage,
  pair,
  rawSocketConnect,
  send,
  startServer,
} from './helpers.ts'

const harnesses: Harness[] = []
const sockets: WebSocket[] = []

afterAll(async () => {
  for (const ws of sockets) ws.terminate()
  for (const harness of harnesses) await harness.server.stop()
})

async function boot(overrides = {}): Promise<Harness> {
  const harness = await startServer(overrides)
  harnesses.push(harness)
  return harness
}

describe('心跳看门狗', () => {
  it('正常 pong 的客户端跨多个心跳周期存活且可继续渲染', async () => {
    const harness = await boot({ heartbeatIntervalMs: 40, pongTimeoutMs: 250 })
    const { ws } = await pair(harness)
    sockets.push(ws)
    await sleep(350) // ≥8 个 ping 周期
    expect(ws.readyState).toBe(ws.OPEN)
    expect(harness.server.isConnected()).toBe(true)
    // 存活连接仍可完成渲染往返
    const pending = harness.server.requestRender('https://alive.example/', 500)
    const req = await nextMessage(ws)
    send(ws, {
      type: 'render-res',
      id: req.id,
      ok: true,
      content: 'still-alive',
      statusCode: 200,
    })
    expect(await pending).toEqual({ content: 'still-alive', statusCode: 200 })
  })

  it('无 pong 的原始连接在判死窗口内被服务端终止', async () => {
    const harness = await boot({ heartbeatIntervalMs: 40, pongTimeoutMs: 150 })
    const raw = await rawSocketConnect(harness.port) // 握手成功后完全静默（不 pong）
    const closed = new Promise<void>((resolve) => {
      raw.once('close', () => resolve())
    })
    await expect(
      Promise.race([
        closed,
        sleep(2000).then(() => Promise.reject(new Error('silent socket not terminated'))),
      ]),
    ).resolves.toBeUndefined()
  })

  it('未配对但正常 pong 的连接不被看门狗误杀', async () => {
    const harness = await boot({ heartbeatIntervalMs: 40, pongTimeoutMs: 250 })
    const idle = await connect(harness.url) // 连上但不 pair；ws 库自动 pong
    sockets.push(idle)
    await sleep(350)
    expect(idle.readyState).toBe(idle.OPEN)
    expect(harness.server.isConnected()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 局部工具
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
