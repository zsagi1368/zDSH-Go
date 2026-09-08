/**
 * cordis 装配面与服务器生命周期测试（真实 Context，非 mock 注册表）。
 */

import net from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { connect, type Harness, send, startServer } from './helpers.ts'

const harnesses: Harness[] = []

afterAll(async () => {
  for (const harness of harnesses) await harness.server.stop()
})

interface PluginShape {
  name: string
  inject: string[]
  Config: unknown
  apply: typeof plugin.apply
}

type PluginArg = Parameters<Context['plugin']>[0]

function shape(): PluginArg {
  const definition: PluginShape = {
    name: plugin.name,
    inject: [...plugin.inject],
    Config: plugin.Config,
    apply: plugin.apply,
  }
  return definition as unknown as PluginArg
}

function peekBridge(ctx: Context): unknown {
  try {
    return (ctx as unknown as Record<string, unknown>).bridge
  } catch {
    return undefined // cordis：访问未提供服务会抛错而非 undefined
  }
}

/** cordis 内置 logger 的环形缓冲：装配层日志的确定性读取通道。 */
function logText(ctx: Context): string {
  const svc = (ctx as unknown as { logger?: { buffer?: { args: unknown[] }[] } }).logger
  return (svc?.buffer ?? []).map(message => message.args.map(String).join(' ')).join('\n')
}

describe('模块出口与配置缺省', () => {
  it('name/inject/Config 形状符合 cordis 插件契约', () => {
    expect(plugin.name).toBe('bridge')
    expect(plugin.inject).toEqual([])
    const schema = plugin.Config as { '~standard'?: { version?: number; validate?: unknown } }
    expect(schema['~standard']?.version).toBe(1)
    expect(typeof schema['~standard']?.validate).toBe('function')
    expect(typeof plugin.apply).toBe('function')
    expect(typeof plugin.BridgeServer).toBe('function')
    expect(typeof plugin.BridgeRenderer).toBe('function')
  })

  it('getPort 分配随机端口且两个实例不冲突', async () => {
    const a = await startServer()
    const b = await startServer()
    harnesses.push(a, b)
    expect(a.port).toBeGreaterThan(0)
    expect(b.port).toBeGreaterThan(0)
    expect(a.port).not.toBe(b.port)
  })

  it('stop 幂等：重复调用不再抛错，端口句柄释放', async () => {
    const harness = await startServer()
    harnesses.push(harness)
    await harness.server.stop()
    await harness.server.stop()
    expect(harness.server.getPort()).toBeUndefined()
  })
})

describe('cordis 装配（真实 Context）', () => {
  it('apply 提供 bridge 命名服务、经 logger 下发一次性 ticket；dispose 后端口释放、服务注销', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(shape(), {})
    await fiber

    // 命名服务在位且实现渲染契约
    const service = peekBridge(ctx) as { render?: unknown; online?: boolean } | undefined
    expect(service).toBeDefined()
    expect(typeof service?.render).toBe('function')

    // 配对流程第一步：ticket 经 logger 输出（start 异步完成后再落日志）
    await waitFor(() => logText(ctx).includes('pairing ticket'), 2000)
    const log = logText(ctx)
    const portMatch = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(log)
    const ticketMatch = /ticket\(60s, single-use\):\s*(\S+)/.exec(log)
    expect(portMatch).not.toBeNull()
    expect(ticketMatch).not.toBeNull()

    // 卸载：effect disposer 关停 http server → 端口不可再连接；服务随 fiber 注销
    const dispose = fiber.dispose()
    if (dispose instanceof Promise) await dispose
    await expect(canConnect(Number(portMatch![1]))).resolves.toBe(false)
    expect(peekBridge(ctx)).toBeUndefined()
  })

  it('enabled=false 时完全不启动：无服务、无桥接日志', async () => {
    const ctx = new Context()
    const before = logText(ctx).length
    const fiber = ctx.plugin(shape(), { enabled: false })
    await fiber
    expect(peekBridge(ctx)).toBeUndefined()
    expect(logText(ctx)).not.toContain('webstack-bridge')
    expect(logText(ctx).length).toBe(before)
    const dispose = fiber.dispose()
    if (dispose instanceof Promise) await dispose
  })

  it('端到端冒烟：日志取 ticket → 配对成功 → 断连触发降级提示日志', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(shape(), {})
    await fiber

    // 端到端冒烟：等 start 落日志 → 取 ticket → 配对成功 → 断连触发降级提示
    await waitFor(() => logText(ctx).includes('pairing ticket'), 2000)
    const log = logText(ctx)
    const port = Number(/ws:\/\/127\.0\.0\.1:(\d+)/.exec(log)![1])
    const ticket = /ticket\(60s, single-use\):\s*(\S+)/.exec(log)![1]

    const ws = await connect(`ws://127.0.0.1:${port}`)
    send(ws, { type: 'pair', id: 1, ticket })
    const paired = await replyOf(ws)
    expect(paired).toContain('"type":"paired"')

    ws.close()
    await waitFor(() => logText(ctx).includes('降级'))

    const dispose = fiber.dispose()
    if (dispose instanceof Promise) await dispose
  })
})

// ---------------------------------------------------------------------------
// 局部工具
// ---------------------------------------------------------------------------

function replyOf(ws: import('ws').WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', data => resolve(String(data)))
    ws.once('close', () => reject(new Error('closed before reply')))
  })
}

/** 探测端口是否仍可建立 TCP 连接。 */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const settle = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

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
