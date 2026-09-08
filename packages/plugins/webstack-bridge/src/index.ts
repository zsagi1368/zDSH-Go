/**
 * WebStack Bridge (网栈·桥) — browser-bridge satellite, host side.
 *
 * Cordis entry: starts the loopback BridgeServer and exposes a named `bridge`
 * service implementing the webstack SeamBridgeRuntime shape. The extension
 * pairs once per host lifetime: take the one-time ticket from the log line
 * below, paste it in the extension popup, and keep the returned long-term key
 * in extension storage — the host process only ever stores sha256(key)
 * (W-B-55 key hygiene; cookies never leave the browser at all).
 *
 * SSRF 闸复用：checkTarget（G1+G2）来自 peer dsh-webstack，经动态导入
 * best-effort 装配；peer 缺席或加载失败时保持 fail-closed（渲染恒 undefined，
 * 内核走 site: 搜索降级），绝不裸放行。
 *
 * @module dsh-webstack-bridge
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { BridgeRenderer, type CheckTargetFn } from './render.ts'

export { BridgeRenderer } from './render.ts'

import { BridgeServer } from './server.ts'

export {
  CLOSE_AUTH_FAILED,
  CLOSE_PAIR_REJECTED,
  CLOSE_PROTOCOL_VIOLATION,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
  DEFAULT_TICKET_TTL_MS,
} from './protocol.ts'
export { BridgeServer } from './server.ts'

/** Cordis plugin name used by loader diagnostics (service name = `bridge`). */
export const name = 'bridge'

/** 无强依赖接缝：web seam / logger 均为可选探测（能力缺失即静默降级）。 */
export const inject: readonly string[] = []

/** Public plugin configuration type. */
export type Config = PluginConfig

export interface PluginConfig {
  /** 总开关；false 时本卫星完全不启动（不占端口、不提供服务）。 */
  enabled?: boolean
}

/**
 * 配置 schema（Standard Schema V1 最小实现）。刻意不依赖 schemastery：
 * 本包唯一的运行时依赖预算给了 ws（Node 无内置 WS 服务端），而配置面只有
 * 一个布尔开关——字面校验器足够，且让本包保持「monorepo 外可编译、零
 * 深路径耦合」的 W-B-05 姿态。
 */
export const Config = Object.freeze({
  '~standard': {
    version: 1,
    validate(value: unknown): { value: PluginConfig } | { issues: { message: string }[] } {
      const input = (typeof value === 'object' && value !== null ? value : {}) as PluginConfig
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
        return { issues: [{ message: 'enabled must be a boolean' }] }
      }
      return { value: { enabled: input.enabled ?? true } }
    },
  },
})

/**
 * 日志解析三级回落（与 webstack apply 同款姿态）：
 * 1. 宿主注入的 `{info}` 服务对象；
 * 2. cordis 内置可调用 LoggerService（`ctx.logger(name).info(...)`）——注意
 *    它是 function 形态的对象，「对象探测」会漏掉，必须单独分支；
 * 3. console.info 兜底（裸环境/测试）。
 */
function resolveInfo(ctx: Context): (message: string) => void {
  let logger: unknown
  try {
    logger = (ctx as unknown as Record<string, unknown>).logger
  } catch {
    logger = undefined // cordis：读取未提供服务会抛错而非 undefined
  }
  const asObject =
    typeof logger === 'object' && logger !== null ? (logger as Record<string, unknown>) : undefined
  const method = asObject?.info
  if (typeof method === 'function') {
    return message => (method as (m: string) => void).call(asObject, message)
  }
  if (typeof logger === 'function') {
    try {
      const named = (logger as unknown as (n: string) => { info?: unknown })(name)
      if (named && typeof named.info === 'function') {
        const info = named.info as (m: string) => void
        return message => info.call(named, message)
      }
    } catch {
      // fall through to console
    }
  }
  return message => console.info(message)
}

/**
 * Assemble the bridge satellite: start the loopback server, provide the named
 * `bridge` service, and emit the one-time pairing ticket through the logger.
 * Everything is registered on the calling fiber — disposal stops the server.
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  if ((config.enabled ?? true) === false) return

  const info = resolveInfo(ctx)

  const server = new BridgeServer({
    issueTicket: () => randomBytes(24).toString('base64url'),
  })
  const renderer = new BridgeRenderer({ server })

  // 命名服务暴露：内核/webstack 经 ctx.bridge（HostSeams.bridge）消费。
  ctx.provide(name, renderer)

  renderer.onDisconnect(() => {
    info('[webstack-bridge] 扩展连接断开——内核将降级 site: 搜索')
  })

  // ---- peer 注入 SSRF 闸（G1+G2 复用 dsh-webstack checkTarget）------------
  // 变量化的 import specifier 防止打包器静态解析深路径；peer 缺席时
  // fail-closed（BridgeRenderer 无闸不放行）。
  const peerName = 'dsh-webstack'
  void import(peerName)
    .then((mod: unknown) => {
      const candidate = (mod as { checkTarget?: unknown }).checkTarget
      if (typeof candidate === 'function') {
        renderer.setTargetChecker(candidate as CheckTargetFn)
      }
    })
    .catch(() => {
      // 卫星允许独立运行：无闸 = 渲染兜底整体不可用，属既定降级而非故障。
    })

  // ---- fiber 生命周期：随插件卸载关停端口与连接 ---------------------------
  ctx.effect(() => {
    void server
      .start()
      .then(() => {
        const port = server.getPort()
        // 配对流程（README §Pairing）：日志取 ticket → 扩展弹窗粘贴 →
        // 长期 key 存扩展 storage；宿主只存哈希。ticket 过期重启宿主或重载插件再取。
        info(
          `[webstack-bridge] ws://127.0.0.1:${port} pairing ticket(60s, single-use): ${server.issueTicket()}`,
        )
      })
      .catch((err: unknown) => {
        info(`[webstack-bridge] start failed: ${String(err)}`)
      })
    return () => {
      void server.stop()
    }
  })
}
