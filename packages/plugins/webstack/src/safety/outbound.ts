/**
 * 统一出站客户端工厂：所有引擎适配器必须经此发请求，直连 fetch 在 lint 层
 * 禁用——保证 SSRF 四道闸不可绕过（分册 05 §1.3）。
 *
 * 单次 outboundFetch 的执行序列：
 * 1. G1+G2 目标核验（checkTarget；DNS 失败归一为 ssrf-blocked/dns-resolution-failed）；
 * 2. `redirect:'manual'` 发起请求，3xx 逐跳复验（assertSafeRedirect，≤5 跳；
 *    跨源跳转剥 Cookie/Authorization，带 Authorization 的跨源跳转直接硬拒）；
 * 3. 双态取消信号：caller signal ∪ timeoutMs 超时 ∪ 内部限流 controller；
 *    已中止 → `aborted`，超时与其它网络异常 → `transport`；
 * 4. G4 有界响应体：reader 循环读，超 maxBytes 即停并 abort 连接，
 *    `bytes` 为实收字节数，`text()` 解码已收内容。
 *
 * 非 2xx 是「数据」不是异常：status 如实上呈，不抛 EngineError。
 * @module webstack/safety/outbound
 */

import { engineError } from '../kernel/errors.ts'
import { redactUrl, scrubText } from './scrub.ts'
import { assertSafeRedirect, checkTarget } from './ssrf.ts'

/** 协议白名单：出站仅允许 http/https（Mimosa 硬性约束）。 */
export const OUTBOUND_PROTOCOLS = ['http:', 'https:'] as const

/** 版本化客户端标识前缀；版本号与包版本同步由测试锁定（W-B-116）。 */
export const USER_AGENT_PRODUCT = 'webstack'

/**
 * 统一出站请求（经 SSRF 四道闸的唯一下网络通道；直连 fetch 在 lint 层禁用）。
 * `method` 当前仅开放 GET；`maxBytes` 是 G4 有界响应体的硬上限。
 */
export interface OutboundRequest {
  url: string
  method?: 'GET'
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes: number
}

/** 统一出站响应：最终 URL 已过 G3 重定向复验，文本读取受 maxBytes 约束。 */
export interface OutboundResponse {
  status: number
  finalUrl: string
  headers: Readonly<Record<string, string>>
  text(): Promise<string>
  bytes: number
}

/** 重定向跳数上限（≤5 跳；第 6 个 3xx 响应即拒绝）。 */
export const MAX_REDIRECT_HOPS = 5

/** 单跳默认超时预算（毫秒）；每跳独立计时。 */
export const DEFAULT_TIMEOUT_MS = 8000

/** 出站客户端函数签名（失败抛 EngineError：transport/rate-limited 等）。 */
export type OutboundFetchFn = (req: OutboundRequest) => Promise<OutboundResponse>

/** 安全取 origin；不可解析时返回空串。 */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** 判定请求头是否携带 Authorization（大小写不敏感）。 */
function hasAuthorization(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === 'authorization')
}

/** 返回剔除 Cookie/Authorization 后的头副本（跨源跳转防凭据泄漏）。 */
function stripSensitiveHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'authorization' || lower === 'cookie') continue
    out[key] = value
  }
  return out
}

/**
 * G4 有界读体：reader 循环累计至 maxBytes 即停；截断时 abort 掉底层连接
 * 防止继续下载。返回实收字节、解码缓存与是否被截断。
 */
async function readBounded(
  res: Response,
  maxBytes: number,
  stop: AbortController,
): Promise<{ bytes: number; text: string }> {
  const chunks: Uint8Array[] = []
  let received = 0
  let overBound = false
  const reader = res.body?.getReader()
  if (reader === undefined) {
    // 无流式 body 的兜底路径（如某些 polyfill）：一次性读入后裁剪。
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes))
      received = maxBytes
      overBound = true
    } else {
      chunks.push(buf)
      received = buf.byteLength
    }
  } else {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || value === undefined) break
      const remaining = maxBytes - received
      if (remaining <= 0) {
        overBound = true
        break
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining))
        received += remaining
        overBound = true
        break
      }
      chunks.push(value)
      received += value.byteLength
    }
    reader.releaseLock()
  }
  if (overBound) stop.abort() // 尽早释放连接，不再消费剩余体

  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk.subarray(0, Math.min(chunk.byteLength, received - offset)), offset)
    offset += chunk.byteLength
    if (offset >= received) break
  }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return { bytes: received, text: decoder.decode(merged) }
}

/**
 * 统一出站客户端：全插件唯一下网络通道（引擎适配器一律经此发请求）。
 *
 * 错误语义（冻结）：非 2xx 正常返回（status 如实），仅网络层异常抛
 * EngineError——`ssrf-blocked`（G1/G2/G3 任一拒绝或 DNS 失败）、`aborted`
 * （caller 中止）、`transport`（超时/DNS 外网络故障/重定向超限/Location 非法）。
 * @param req  出站请求（url/maxBytes 必填）
 * @param opts 可选豁免表：透传给 G2（host:port 与 CIDR），永不影响 G1/G3/G4
 */
export async function outboundFetch(
  req: OutboundRequest,
  opts?: { exemptions?: readonly string[] },
): Promise<OutboundResponse> {
  if (req.signal?.aborted) {
    throw engineError('aborted', 'outbound request aborted before start', {})
  }

  const exemptions = opts?.exemptions
  let currentUrl = req.url
  let headers: Record<string, string> = req.headers === undefined ? {} : { ...req.headers }
  const hadAuthHeader = hasAuthorization(headers)
  let hop = 0

  for (;;) {
    // ---- G1 + G2 目标核验 -------------------------------------------------
    let verdict: Awaited<ReturnType<typeof checkTarget>>
    try {
      verdict = await checkTarget(currentUrl, exemptions)
    } catch (cause) {
      // W10 审计加固：消息拼接必须经 redactUrl——目标 URL 的 query 可能携带
      // 引擎密钥/敏感参数（与 ssrf.assertSafeRedirect 同一纪律）。
      throw engineError('ssrf-blocked', `target dns resolution failed: ${redactUrl(currentUrl)}`, {
        detail: 'dns-resolution-failed',
        cause,
      })
    }
    if (!verdict.allowed) {
      // exactOptionalPropertyTypes：reasonCode 理论上必在拒绝分支，仍做缺省兜底。
      const detail = verdict.reasonCode ?? 'unknown-reason'
      throw engineError('ssrf-blocked', `blocked by ${verdict.gate ?? 'G1-static'}: ${detail}`, {
        detail,
      })
    }

    // ---- 双态取消信号：caller ∪ 每跳超时 ∪ 内部限流 -----------------------
    const stop = new AbortController()
    const signals: AbortSignal[] = [
      AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      stop.signal,
    ]
    if (req.signal !== undefined) signals.unshift(req.signal)
    const composed = AbortSignal.any(signals)

    // ---- 发起请求（redirect:'manual'，3xx 由本层逐跳复验）-----------------
    let res: Response
    try {
      res = await globalThis.fetch(currentUrl, {
        method: req.method ?? 'GET',
        headers,
        redirect: 'manual',
        signal: composed,
      })
    } catch (thrown) {
      if (req.signal?.aborted)
        throw engineError('aborted', 'outbound request aborted by caller', {})
      if (composed.aborted && !stop.signal.aborted) {
        throw engineError(
          'transport',
          `outbound request timed out after ${req.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
          {
            detail: 'timeout',
            cause: thrown,
          },
        )
      }
      throw engineError('transport', `network failure fetching ${safeOrigin(currentUrl)}`, {
        cause: thrown,
      })
    }

    // ---- G3 重定向逐跳复验 -------------------------------------------------
    const location = res.headers.get('location')
    const isRedirect = res.status >= 300 && res.status < 400 && location !== null
    if (!isRedirect) {
      const bounded = await readBounded(res, req.maxBytes, stop)
      return {
        status: res.status,
        finalUrl: currentUrl,
        headers: Object.fromEntries(res.headers.entries()),
        bytes: bounded.bytes,
        text: async () => bounded.text,
      }
    }

    if (hop >= MAX_REDIRECT_HOPS) {
      throw engineError(
        'transport',
        `redirect limit exceeded (${MAX_REDIRECT_HOPS} hops) at ${safeOrigin(currentUrl)}`,
        {
          detail: 'redirect-limit-exceeded',
        },
      )
    }
    void res.body?.cancel().catch(() => undefined) // 释放中间跳的空体连接

    let nextUrl: string
    try {
      nextUrl = new URL(location, currentUrl).toString()
    } catch (cause) {
      // W10 审计加固：Location 是对端可控的自由文本，进错误消息前截断+脱敏，
      // 防日志/上下文注入式长串与敏感 query 顺流而上（scrubText 保留可诊断性）。
      throw engineError(
        'transport',
        `invalid Location header: ${scrubText(location.slice(0, 256))}`,
        {
          cause,
        },
      )
    }
    await assertSafeRedirect(currentUrl, nextUrl, hadAuthHeader, exemptions)

    // 跨源跳转剥 Cookie/Authorization（带 Authorization 的跨源已在 assert 硬拒，
    // 此处兜底处理 Cookie 及其它实现差异）。
    if (safeOrigin(nextUrl) !== safeOrigin(currentUrl)) {
      headers = stripSensitiveHeaders(headers)
    }
    currentUrl = nextUrl
    hop++
  }
}
