/**
 * Windows 系统代理探测（尽力而为层）：经 `reg query` 读
 * HKCU\\...\\Internet Settings 的 ProxyEnable/ProxyServer，仅在「已启用且
 * 服务器非空」时返回代理串；结果缓存 5 分钟，避免每次出站都拉起子进程。
 *
 * 诚实边界（务必如实理解）：
 * - 本模块只是**环境变量注入层**——Node 内建 fetch（undici）默认**不读**
 *   HTTPS_PROXY/HTTP_PROXY 环境变量；对 env 代理的支持随运行时与 HTTP 客户端
 *   实现而异。设置这些变量是社区约定的尽力而为转发，不是保证；
 * - 仅当用户在配置中显式开启时才调用 {@link applyProxyToEnv}（默认关闭，
 *   不偷改进程环境）；非 win32 平台探测直接返回 undefined。
 *
 * @module webstack/safety/winproxy
 */

import { execFile } from 'node:child_process'

/** 系统代理所在的注册表键（HKCU 当前用户视图）。 */
const INTERNET_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** 探测结果缓存时长（毫秒）。 */
export const WINDOWS_PROXY_CACHE_TTL_MS = 5 * 60_000

/** 缓存槽：值 + 写入时刻；undefined 值同样缓存（负缓存同样防抖）。 */
interface ProxyCache {
  readonly at: number
  readonly value: string | undefined
}

let cache: ProxyCache | undefined

/** 测试专用：清空探测结果缓存（生产代码不得调用）。 */
export function resetWindowsProxyCacheForTest(): void {
  cache = undefined
}

/**
 * 执行一次 reg query 并取目标值的最后一个空白分隔 token。
 * 输出行形如 `    ProxyEnable    REG_DWORD    0x1`；reg 缺失/键不存在/
 * 任何异常一律 resolve(undefined)（探测永不抛错）。
 */
function regQueryValue(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('reg', ['query', INTERNET_SETTINGS_KEY, '/v', name], (error, stdout) => {
      if (error !== null || typeof stdout !== 'string') {
        resolve(undefined)
        return
      }
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed.startsWith(name)) continue
        const parts = trimmed.split(/\s+/)
        const value = parts.at(-1)
        resolve(value === undefined || value === '' ? undefined : value)
        return
      }
      resolve(undefined)
    })
  })
}

/** 单次完整探测：ProxyEnable=0x1 且 ProxyServer 非空才返回服务器串。 */
async function probeOnce(): Promise<string | undefined> {
  try {
    const enable = await regQueryValue('ProxyEnable')
    if (enable?.toLowerCase() !== '0x1') return undefined // 未启用或读取失败
    const server = await regQueryValue('ProxyServer')
    const trimmed = server?.trim()
    return trimmed === undefined || trimmed === '' ? undefined : trimmed
  } catch {
    return undefined
  }
}

/**
 * 探测 Windows 系统代理：命中（启用 + 服务器存在）返回形如
 * `127.0.0.1:8888` 的原始 ProxyServer 值；否则 undefined。
 * 非 win32 直接返回 undefined（不发子进程）。结果缓存 5 分钟。
 */
export async function getWindowsSystemProxy(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  if (cache !== undefined && Date.now() - cache.at < WINDOWS_PROXY_CACHE_TTL_MS) {
    return cache.value
  }
  const value = await probeOnce()
  cache = { at: Date.now(), value }
  return value
}

/**
 * 把代理串注入 HTTPS_PROXY / HTTP_PROXY 环境变量（尽力而为层，见模块头
 * 诚实边界说明）。proxy 为 undefined/空白时不动环境。仅应在用户配置开启时
 * 调用——本函数不判断开关，职责单一。
 */
export function applyProxyToEnv(proxy?: string): void {
  const trimmed = proxy?.trim()
  if (trimmed === undefined || trimmed === '') return
  process.env.HTTPS_PROXY = trimmed
  process.env.HTTP_PROXY = trimmed
}
