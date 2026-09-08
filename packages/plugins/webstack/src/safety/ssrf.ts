/**
 * SSRF 纵深四道闸（W-B-50 / F-007）：G1 静态校验 → G2 DNS 解析核验 →
 * G3 重定向逐跳复验 → G4 有界响应体。豁免只跳过 G2 网段判定，永不跳过
 * G1/G3/G4。判定基于解析后 IP 而非 hostname 字符串黑名单——`localhost`
 * 字符串绕过、自建 DNS 重绑定（TOCTOU 由 outbound 每跳复验兜底）均失效。
 *
 * 端口治理采用**黑名单制**而非白名单制：SearXNG / Crawl4AI 等自托管引擎
 * 常部署在 8080、11235 等高位端口，白名单会把合法自托管实例一刀切死；
 * 黑名单只封已知高危服务端口（SSH/Telnet/SMTP/DNS/RPC/SMB/数据库等），
 * 对高位业务端口保持放行，由 G2 网段判定承担真正的内网防护。
 * @module webstack/safety/ssrf
 */

import { lookup } from 'node:dns/promises'
import { engineError } from '../kernel/errors.ts'
import type { SafetyGate, SafetyVerdict, SsrfRejectReason } from '../kernel/types.ts'
import { redactUrl } from './scrub.ts'

/** 放行裁决便捷构造。 */
export function allow(): SafetyVerdict {
  return { allowed: true }
}

/** 拒绝裁决便捷构造：必须携带闸位与原因码（i18n/处方按 reasonCode 派生）。 */
export function reject(
  gate: SafetyGate,
  reasonCode: SsrfRejectReason,
  detail?: string,
): SafetyVerdict {
  return detail === undefined
    ? { allowed: false, gate, reasonCode }
    : { allowed: false, gate, reasonCode, detail }
}

// ---------------------------------------------------------------------------
// G1 静态闸词汇
// ---------------------------------------------------------------------------

/**
 * 高危服务端口黑名单（G1）：SSH(22)/Telnet(23)/SMTP(25)/DNS(53)/RPC(135)/
 * NetBIOS(139/445)/MySQL(3306)/RDP(3389)/PostgreSQL(5432)/Redis(6379)/
 * MongoDB(27017)。黑名单制理由见模块头注释——自托管引擎常用 8080/11235
 * 高位端口，白名单制会误杀合法实例。
 */
export const BLOCKED_PORTS: readonly number[] = Object.freeze([
  22, 23, 25, 53, 135, 139, 445, 3306, 3389, 5432, 6379, 27017,
])

// ---------------------------------------------------------------------------
// IP 分类纯函数（G2 判定核心；无任何 IO，可独立表驱动测试）
// ---------------------------------------------------------------------------

/** IP 风险类别：`unknown` 仅出现在无法解析的输入上（G2 按 fail-closed 处理）。 */
export type IpClass = 'loopback' | 'private' | 'link-local' | 'reserved' | 'public' | 'unknown'

/** `::ffff:` 前缀的 IPv4 映射地址（如 ::ffff:127.0.0.1）——按 v4 规则判定。 */
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

/** 点分十进制 IPv4 → 32 位无符号整数；非法输入返回 null。 */
function ipv4ToUint32(dotted: string): number | null {
  const parts = dotted.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out = out * 256 + n
  }
  return out >>> 0
}

/** IPv4 数值分类（RFC 1918/3927/6598 及保留段清单见分册 05 §4）。 */
function classifyV4(n: number): IpClass {
  const o1 = n >>> 24
  const o2 = (n >>> 16) & 0xff
  const o3 = (n >>> 8) & 0xff
  if (o1 === 127) return 'loopback' // 127/8
  if (o1 === 10) return 'private' // 10/8
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return 'private' // 172.16/12
  if (o1 === 192 && o2 === 168) return 'private' // 192.168/16
  if (o1 === 169 && o2 === 254) return 'link-local' // 169.254/16
  if (o1 === 0) return 'reserved' // 0/8
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return 'reserved' // 100.64/10 CGNAT
  if (o1 === 192 && o2 === 0 && o3 === 0) return 'reserved' // 192.0.0/24
  if (o1 === 198 && (o2 === 18 || o2 === 19)) return 'reserved' // 198.18/15 benchmark
  if (o1 >= 224) return 'reserved' // 224/4 组播 + 240/4 保留（含 255.255.255.255）
  return 'public'
}

/**
 * 展开 IPv6 为 8 个 hextet 数组；支持 `::` 压缩与尾段内嵌 IPv4。
 * 非法输入返回 null。zone id（%eth0）剥离后忽略。
 */
function ipv6Hextets(ip: string): readonly number[] | null {
  let s = ip.trim().toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!s.includes(':')) return null
  const halves = s.split('::')
  if (halves.length > 2) return null

  /** 解析冒号分段为 hextet 数组；含 '.' 的段只允许出现在末尾并按 v4 展开。 */
  const parseGroups = (raw: string): readonly number[] | null => {
    if (raw === '') return []
    const segs = raw.split(':')
    const groups: number[] = []
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      if (seg === undefined || seg === '') return null
      if (seg.includes('.')) {
        if (i !== segs.length - 1) return null
        const v4 = ipv4ToUint32(seg)
        if (v4 === null) return null
        groups.push(v4 >>> 16, v4 & 0xffff)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(seg)) return null
      groups.push(Number.parseInt(seg, 16))
    }
    return groups
  }

  const head = parseGroups(halves[0] ?? '')
  if (head === null) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const tail = parseGroups(halves[1] ?? '')
  if (tail === null) return null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null // '::' 必须至少压缩一个全零组
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail]
}

/**
 * 纯 IPv6 分类：仅清单化 ::1/fc00::/7/fe80::/10 与未指定地址 ::。
 * W10 审计加固：`::ffff:<v4>` 的**十六进制缩写形态**（如 `::ffff:7f00:1`，
 * 即 inet_ntop 对映射地址的规范输出）与点分形态同权——剥 `::ffff:0:0/96`
 * 前缀后完全按 v4 规则判定；NAT64 已知前缀 `64:ff9b::/96` 按 fail-closed
 * 归入 reserved（其尾嵌 v4 经网关可折返内网）。
 */
function classifyV6(groups: readonly number[]): IpClass {
  const last = groups[7] ?? 0
  const allZeroExceptLast = groups.every((g, i) => i === 7 || g === 0)
  if (allZeroExceptLast) return last === 1 ? 'loopback' : 'reserved' // ::1 与 ::
  const first = groups[0] ?? 0
  if (first === 0x64 && (groups[1] ?? 0) === 0xff9b) {
    // 64:ff9b::/96（RFC 6052 NAT64 已知前缀）：尾 32 位经网关折返可达任意
    // v4（含内网），一律按 reserved fail-closed 处理。
    return 'reserved'
  }
  if ((groups[5] ?? 0) === 0xffff && groups.every((g, i) => i >= 5 || g === 0)) {
    // IPv4 映射前缀（::ffff:0:0/96）：按内嵌 v4 复判，堵十六进制缩写绕过。
    const v4 = (((groups[6] ?? 0) << 16) | last) >>> 0
    return classifyV4(v4)
  }
  if (first >= 0xfc00 && first <= 0xfdff) return 'private' // fc00::/7 ULA
  if (first >= 0xfe80 && first <= 0xfebf) return 'link-local' // fe80::/10
  return 'public'
}

/**
 * IP 风险分类纯函数：IPv4、纯 IPv6 与 `::ffff:` 映射地址统一判定；
 * 映射地址剥前缀后完全按 v4 规则走（防 `::ffff:127.0.0.1` 绕过）。
 */
export function classifyIp(ip: string): IpClass {
  const trimmed = ip.trim()
  const mapped = IPV4_MAPPED.exec(trimmed)
  const v4 = ipv4ToUint32(mapped?.[1] ?? trimmed)
  if (v4 !== null) return classifyV4(v4)
  const groups = ipv6Hextets(trimmed)
  return groups === null ? 'unknown' : classifyV6(groups)
}

// ---------------------------------------------------------------------------
// 豁免表（host:port 与 CIDR 两种形态；命中仅跳过 G2）
// ---------------------------------------------------------------------------

interface Exemption {
  host?: string
  port?: string
  cidr?: { base: number; bits: number }
}

/**
 * 解析豁免条目；无法识别的条目安全忽略（豁免宁缺勿滥）。host 侧容忍
 * `[::1]:8080` 方括号形态（与 URL hostname 的无括号规范形对齐）。
 */
function parseExemptions(entries: readonly string[]): Exemption[] {
  const list: Exemption[] = []
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry.includes('/')) {
      const [base, bitsRaw] = entry.split('/')
      const bits = Number(bitsRaw)
      const baseV4 = base === undefined ? null : ipv4ToUint32(base)
      if (baseV4 === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue // IPv6 CIDR 不支持
      list.push({ cidr: { base: baseV4, bits } })
      continue
    }
    const colon = entry.lastIndexOf(':')
    if (colon > 0) {
      let host = entry.slice(0, colon)
      const port = entry.slice(colon + 1)
      // 方括号 IPv6 字面量剥壳：'[::1]' 与 URL hostname '::1' 同一比较域。
      if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
      if (/^\d{1,5}$/.test(port)) {
        list.push({ host, port })
        continue
      }
    }
    list.push({ host: entry }) // 裸 host：匹配任意端口
  }
  return list
}

/** scheme 缺省端口（豁免 `host:port` 对缺省端口 URL 的等价匹配用）。 */
function defaultPortOf(protocol: string): string {
  if (protocol === 'https:') return '443'
  if (protocol === 'http:') return '80'
  return ''
}

/** host:port 形态豁免是否命中当前 URL（命中则整段跳过 G2，不做 DNS）。 */
function hostExempt(parsed: URL, list: readonly Exemption[]): boolean {
  // WHATWG URL 对 IPv6 字面量保留方括号（'[fe80::1]'），剥壳后与豁免条目的
  // 无括号规范形对齐；缺省端口按 scheme 等价展开——`example.com:443` 必须命中
  // `https://example.com/`（parsed.port 为空串），否则豁免静默失效。
  let hostname = parsed.hostname.toLowerCase()
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  const effectivePort = parsed.port === '' ? defaultPortOf(parsed.protocol) : parsed.port
  return list.some(
    e =>
      e.host !== undefined &&
      e.host === hostname &&
      (e.port === undefined || e.port === parsed.port || e.port === effectivePort),
  )
}

/** CIDR 豁免是否覆盖该已解析地址（仅 IPv4；v6 无 CIDR 豁免）。 */
function cidrExempt(ip: string, list: readonly Exemption[]): boolean {
  const mapped = IPV4_MAPPED.exec(ip.trim())
  const v4 = ipv4ToUint32(mapped?.[1] ?? ip.trim())
  if (v4 === null) return false
  return list.some((e) => {
    if (e.cidr === undefined) return false
    const shift = 32 - e.cidr.bits
    return v4 >>> shift === (e.cidr.base >>> shift) >>> 0
  })
}

// ---------------------------------------------------------------------------
// G1 + G2 主入口
// ---------------------------------------------------------------------------

/**
 * 目标核验主入口：先 G1 静态校验（scheme/userinfo/端口黑名单），再经 DNS
 * 把 hostname 解析为**全部**地址逐个做网段判定（任一地址落入受限段即拒，
 * 防「公网域名解析到内网 IP」的 DNS 重绑定面）。DNS 层失败不在此吞掉——
 * 上抛由 outbound 归一为 ssrf-blocked/dns-resolution-failed。
 * @param url        待检目标 URL
 * @param exemptions 豁免表：`host:port`（跳过 G2 且不发起 DNS）与 IPv4 CIDR
 *                   （对已解析地址放行）；永不影响 G1/G3/G4
 */
export async function checkTarget(
  url: string,
  exemptions?: readonly string[],
): Promise<SafetyVerdict> {
  const list = exemptions === undefined ? [] : parseExemptions(exemptions)

  // ---- G1 静态闸 ----------------------------------------------------------
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return reject('G1-static', 'scheme-disallowed', 'url-parse-failed')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return reject('G1-static', 'scheme-disallowed', parsed.protocol)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return reject('G1-static', 'userinfo-present', redactUrl(url))
  }
  const portNum = parsed.port === '' ? undefined : Number(parsed.port)
  if (portNum !== undefined && BLOCKED_PORTS.includes(portNum)) {
    return reject('G1-static', 'nonstandard-port', String(portNum))
  }

  // ---- 豁免短路（仅跳过 G2）----------------------------------------------
  if (hostExempt(parsed, list)) return allow()

  // ---- G2 DNS 核验 --------------------------------------------------------
  // DNS 故障语义由 outbound 统一归一为 ssrf-blocked/dns-resolution-failed，
  // 此处刻意不吞错，保留原始 cause 可诊断。
  const addresses: readonly { address: string; family: number }[] = await lookup(parsed.hostname, {
    all: true,
  })
  for (const addr of addresses) {
    const cls = classifyIp(addr.address)
    const reason: SsrfRejectReason | undefined =
      cls === 'loopback'
        ? 'loopback'
        : cls === 'private'
          ? 'private-range'
          : cls === 'link-local'
            ? 'link-local'
            : cls === 'reserved' || cls === 'unknown'
              ? 'reserved-range' // unknown 按 fail-closed 并入 reserved
              : undefined
    if (reason !== undefined && !cidrExempt(addr.address, list)) {
      return reject('G2-dns', reason, `${addr.address} classified ${cls}`)
    }
  }
  return allow()
}

// ---------------------------------------------------------------------------
// G3 重定向复验
// ---------------------------------------------------------------------------

/** 安全取 origin；不可解析时返回空串（调用侧必然先过 G1，此为防御兜底）。 */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * G3 重定向逐跳复验：目标 URL 先完整过 G1+G2，任一拒绝即抛
 * `ssrf-blocked`（detail=redirect-to-blocked）；随后若原请求带 Authorization
 * 头且重定向跨源，抛 `ssrf-blocked`（detail=redirect-cross-origin-auth）——
 * 凭据头跟随跨源跳转是最高危泄漏面，直接硬拒而非降级剥头。
 * @param fromUrl       跳转来源 URL（用于诊断消息，经 redactUrl 脱敏）
 * @param toUrl         Location 解析出的绝对目标 URL
 * @param hadAuthHeader 原请求是否携带 Authorization 头
 * @param exemptions    透传给 G2 的豁免表（语义同 checkTarget）
 * @throws EngineError(code='ssrf-blocked') 目标被拒或凭据跨源
 */
export async function assertSafeRedirect(
  fromUrl: string,
  toUrl: string,
  hadAuthHeader: boolean,
  exemptions?: readonly string[],
): Promise<void> {
  let verdict: SafetyVerdict
  try {
    verdict = await checkTarget(toUrl, exemptions)
  } catch (cause) {
    throw engineError(
      'ssrf-blocked',
      `redirect target dns resolution failed: ${redactUrl(fromUrl)} -> ${redactUrl(toUrl)}`,
      {
        detail: 'dns-resolution-failed',
        cause,
      },
    )
  }
  if (!verdict.allowed) {
    throw engineError(
      'ssrf-blocked',
      `redirect to blocked target (${verdict.gate}/${verdict.reasonCode}): ${redactUrl(fromUrl)} -> ${redactUrl(toUrl)}`,
      { detail: 'redirect-to-blocked' },
    )
  }
  if (hadAuthHeader && safeOrigin(toUrl) !== safeOrigin(fromUrl)) {
    throw engineError(
      'ssrf-blocked',
      `cross-origin redirect with Authorization header: ${redactUrl(fromUrl)} -> ${redactUrl(toUrl)}`,
      { detail: 'redirect-cross-origin-auth' },
    )
  }
}
