/**
 * W9 winproxy 兜底门控回归：advanced.winProxyFallback=true 时 activate 早期
 * 探测并注入 env；默认关闭绝不触碰进程环境。
 */
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it, vi } from 'vitest'

const winproxyMock = vi.hoisted(() => ({
  probes: [] as unknown[],
  applied: [] as Array<string | undefined>,
}))
vi.mock('../src/safety/winproxy.ts', () => ({
  getWindowsSystemProxy: async (...args: unknown[]) => {
    winproxyMock.probes.push(args)
    return '127.0.0.1:8888'
  },
  applyProxyToEnv: (proxy?: string) => {
    winproxyMock.applied.push(proxy)
    return undefined
  },
}))

afterEach(() => {
  winproxyMock.probes.length = 0
  winproxyMock.applied.length = 0
})

async function freshContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  return ctx
}

describe('winproxy 兜底门控（装配层）', () => {
  it('winProxyFallback=true → activate 早期探测一次并注入探测到的代理串', async () => {
    const { assembleWebstack } = await import('../src/index.ts')
    const ctx = await freshContext()
    assembleWebstack(ctx, { winProxyFallback: true })
    // 注入是 fire-and-forget：让微任务队列排空。
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(winproxyMock.probes).toHaveLength(1)
    expect(winproxyMock.applied).toEqual(['127.0.0.1:8888'])
  })

  it('缺省（false）→ 不探测、不注入', async () => {
    const { assembleWebstack } = await import('../src/index.ts')
    const ctx = await freshContext()
    assembleWebstack(ctx, {})
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(winproxyMock.probes).toHaveLength(0)
    expect(winproxyMock.applied).toHaveLength(0)
  })
})
