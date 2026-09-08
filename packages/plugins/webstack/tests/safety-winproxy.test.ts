/**
 * Windows 系统代理探测（全离线）：vi.mock('node:child_process') 替换 execFile，
 * 覆盖 enable/disable/缺值/缓存命中与重置/env 注入边界。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  applyProxyToEnv,
  getWindowsSystemProxy,
  resetWindowsProxyCacheForTest,
  WINDOWS_PROXY_CACHE_TTL_MS,
} from '../src/safety/winproxy.ts'

/** 构造 reg query 成功输出：键头行 + 值行。 */
function regStdout(name: string, value: string): string {
  return [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    `    ${name}    REG_DWORD    ${value}`,
    '',
    '',
  ].join('\r\n')
}

/** 让 execFileMock 按 /v 参数名返回预设应答。 */
function mockRegistry(values: Record<string, string | undefined>): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: readonly string[],
      callback: (err: Error | null, stdout: string) => void,
    ) => {
      const name = args.at(-1) ?? ''
      const value = values[name]
      if (value === undefined || args.includes('/v') === false) {
        callback(new Error('The system was unable to find the specified registry key'), '')
        return undefined
      }
      callback(null, regStdout(name, value))
      return undefined
    },
  )
}

const ORIGINAL_ENV = { ...process.env }
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  resetWindowsProxyCacheForTest()
  execFileMock.mockReset()
})

describe('getWindowsSystemProxy', () => {
  it('常量：缓存 TTL 为 5 分钟', () => {
    expect(WINDOWS_PROXY_CACHE_TTL_MS).toBe(5 * 60_000)
  })

  it('ProxyEnable=0x1 且 ProxyServer 存在 → 返回服务器串，reg 参数正确', async () => {
    mockRegistry({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:8888' })
    await expect(getWindowsSystemProxy()).resolves.toBe('127.0.0.1:8888')
    expect(execFileMock).toHaveBeenCalledWith(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
      ],
      expect.any(Function),
    )
  })

  it('ProxyEnable=0x0 → 未启用返回 undefined 且不再查询 ProxyServer', async () => {
    mockRegistry({ ProxyEnable: '0x0', ProxyServer: '10.0.0.1:3128' })
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined()
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('启用但 ProxyServer 键缺失 → undefined', async () => {
    mockRegistry({ ProxyEnable: '0x1' })
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined()
  })

  it('reg 缺失/查询报错 → 探测静默返回 undefined（永不抛）', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: readonly string[], cb: (err: Error | null) => void) => {
        cb(new Error('reg not found'))
        return undefined
      },
    )
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined()
  })

  it('结果缓存：TTL 内第二次调用不再拉起子进程；重置后重新探测', async () => {
    let enable = '0x1'
    execFileMock.mockImplementation(
      (_cmd: string, args: readonly string[], cb: (err: Error | null, stdout: string) => void) => {
        const name = args.at(-1) ?? ''
        if (name === 'ProxyEnable') {
          cb(null, regStdout('ProxyEnable', enable))
          return undefined
        }
        cb(null, regStdout('ProxyServer', 'proxy.local:8080'))
        return undefined
      },
    )
    await getWindowsSystemProxy()
    await getWindowsSystemProxy()
    expect(execFileMock).toHaveBeenCalledTimes(2) // enable + server 各一次

    // 关掉系统代理后 TTL 内仍命中旧缓存。
    enable = '0x0'
    await expect(getWindowsSystemProxy()).resolves.toBe('proxy.local:8080')
    expect(execFileMock).toHaveBeenCalledTimes(2)

    resetWindowsProxyCacheForTest()
    await expect(getWindowsSystemProxy()).resolves.toBeUndefined() // 重新探测到 0x0（短路，不再查 Server）
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })

  it('非 win32 平台直接返回 undefined 且不执行 reg', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      await expect(getWindowsSystemProxy()).resolves.toBeUndefined()
      expect(execFileMock).not.toHaveBeenCalled()
    } finally {
      if (originalPlatformDescriptor !== undefined) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor)
      }
    }
  })
})

describe('applyProxyToEnv', () => {
  it('注入 HTTPS_PROXY 与 HTTP_PROXY（trim 后）', () => {
    applyProxyToEnv('  127.0.0.1:8888  ')
    expect(process.env.HTTPS_PROXY).toBe('127.0.0.1:8888')
    expect(process.env.HTTP_PROXY).toBe('127.0.0.1:8888')
  })

  it('undefined / 空白串不动环境', () => {
    delete process.env.HTTPS_PROXY
    delete process.env.HTTP_PROXY
    applyProxyToEnv(undefined)
    applyProxyToEnv('   ')
    expect(process.env.HTTPS_PROXY).toBeUndefined()
    expect(process.env.HTTP_PROXY).toBeUndefined()
  })
})

afterEach(() => {
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY']) {
    const value = ORIGINAL_ENV[key as keyof typeof ORIGINAL_ENV]
    // oxlint-disable-next-line typescript/no-dynamic-delete -- dropping a process.env key needs delete.
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor)
  }
})
