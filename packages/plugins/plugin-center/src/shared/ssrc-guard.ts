import { CpErrorCode, type CpResult } from './types.js'

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
])

function ipv4ToInt(h: string): number | null {
  const parts = h.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255 || !/^\d+$/.test(part)) {
      return null
    }
    value = value * 256 + n
  }
  return value
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base)
  if (baseInt === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ip & mask) === (baseInt & mask)
}

/**
 * Decide whether a host (already lower-cased, brackets stripped) is safe for
 * outbound requests. Rejects loopback, private, link-local, CGNAT, multicast,
 * reserved and IPv4-mapped IPv6 forms.
 */
export function isHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    return false
  }
  if (/^::ffff:(\d{1,3}\.){3}\d{1,3}$/i.test(host)) {
    // IPv4-mapped IPv6: unwrap and judge the embedded IPv4 literal.
    return judgeIpv4Literal(host.slice(7))
  }
  if (host.includes(':')) {
    // Bare IPv6 literal: normalize then compare against blocked prefixes.
    const normalized = host
    if (normalized.toLowerCase().startsWith('::ffff:')) {
      return judgeIpv4Literal(normalized.slice(7))
    }
    // Expand :: shorthand for prefix checks.
    const halves = normalized.split('::')
    let groups: string[]
    if (halves.length === 2) {
      const left = halves[0] ? halves[0].split(':') : []
      const right = halves[1] ? halves[1].split(':') : []
      const fill = 8 - left.length - right.length
      if (fill < 0) return false
      groups = [...left, ...Array<string>(fill).fill('0'), ...right]
    } else {
      groups = normalized.split(':')
    }
    if (groups.length !== 8) return false
    const hex = groups.map(g => parseInt(g, 16))
    if (hex.some(n => Number.isNaN(n))) return false
    const first = hex[0] as number
    if (hex.every(n => n === 0)) return false // ::
    // ::1 loopback
    if (
      hex.slice(0, 7).every(n => n === 0) &&
      (hex[7] as number) === 1
    ) {
      return false
    }
    // hex-form IPv4-mapped (::ffff:0:0/96)
    if (
      hex.slice(0, 5).every(n => n === 0) &&
      hex[5] === 0xffff
    ) {
      return judgeIpv4Literal(hexGroupsToIpv4(hex[6] as number, hex[7] as number))
    }
    // IPv4-compatible ::/96 (e.g. ::127.0.0.1 in hex form `::7f00:1`)
    if (hex.slice(0, 6).every(n => n === 0) && !hex.slice(6).every(n => n === 0)) {
      return judgeIpv4Literal(hexGroupsToIpv4(hex[6] as number, hex[7] as number))
    }
    // NAT64 embeds an IPv4 address in the low 32 bits — both the well-known
    // prefix 64:ff9b::/96 (RFC 6052) and the local-use 64:ff9b:1::/96
    // (RFC 8215) count.
    if (
      first === 0x0064 &&
      hex[1] === 0xff9b &&
      (hex[2] === 0 || hex[2] === 1) &&
      hex.slice(3, 6).every(n => n === 0)
    ) {
      return judgeIpv4Literal(hexGroupsToIpv4(hex[6] as number, hex[7] as number))
    }
    if ((first & 0xfe00) === 0xfc00) return false // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return false // ff00::/8 multicast
    return true
  }
  const v4 = ipv4ToInt(host)
  if (v4 !== null) return judgeIpv4(v4)
  // Numeric forms the strict dotted parser rejected (`2130706433`, `127.1`,
  // `0x7f000001`, `0177.0.0.1`): OS resolvers still turn these into
  // addresses, so judge them under full inet_aton semantics — and refuse
  // outright when even that cannot parse them.
  const flexible = parseFlexibleIpv4(host)
  if (flexible !== null) return judgeIpv4(flexible)
  if (/^[0-9.]+$/.test(host)) return false
  if (host.length > 253) return false
  if (host.endsWith('.local') || host.endsWith('.internal')) return false // mDNS / internal
  // Regular DNS name: every dot-separated label must be non-empty, ≤63 chars,
  // and start/end alphanumeric (rejects '.', '..', '-x-', trailing-dot junk).
  return (
    host.split('.').every(label => label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) &&
    /[a-z0-9]/.test(host)
  )
}

function hexGroupsToIpv4(high: number, low: number): string {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.')
}

function judgeIpv4Literal(literal: string): boolean {
  const v4 = ipv4ToInt(literal)
  return v4 !== null && judgeIpv4(v4)
}

function judgeIpv4(ip: number): boolean {
  if (inCidr4(ip, '0.0.0.0', 8)) return false // this-network + 0.0.0.0
  if (inCidr4(ip, '10.0.0.0', 8)) return false // private
  if (inCidr4(ip, '127.0.0.0', 8)) return false // loopback
  if (inCidr4(ip, '169.254.0.0', 16)) return false // link-local
  if (inCidr4(ip, '172.16.0.0', 12)) return false // private
  if (inCidr4(ip, '192.168.0.0', 16)) return false // private
  if (inCidr4(ip, '100.64.0.0', 10)) return false // CGNAT shared address space
  if (inCidr4(ip, '224.0.0.0', 4)) return false // multicast
  if (inCidr4(ip, '240.0.0.0', 4)) return false // reserved
  return true
}

/**
 * Full inet_aton-style parsing: OS resolvers accept `2130706433`, `127.1`,
 * `0x7f000001` and `0177.0.0.1` as loopback, so the guard must judge every
 * numeric form instead of letting it fall through to the DNS-name path.
 * Returns null when the string is not a numeric IPv4 form at all.
 */
export function parseFlexibleIpv4(host: string): number | null {
  if (!/^[0-9xXa-fA-F.]+$/.test(host) || !/\d/.test(host)) return null
  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4 || parts.some(p => p === '')) return null
  const values: number[] = []
  for (const part of parts) {
    let value: number
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      value = Number.parseInt(part, 16)
    } else if (/^0[0-7]+$/.test(part)) {
      value = Number.parseInt(part, 8)
    } else if (/^\d+$/.test(part)) {
      value = Number.parseInt(part, 10)
    } else {
      return null
    }
    if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return null
    values.push(value)
  }
  // Classic inet_aton layout: every part except the last is one byte; the
  // last part fills the remaining width (`127.1` == `127.0.0.1`).
  const lastWidthBytes = 5 - values.length
  const last = values[values.length - 1] as number
  if (last >= 256 ** lastWidthBytes) return null
  let high = 0
  for (let index = 0; index < values.length - 1; index += 1) {
    const v = values[index] as number
    if (v > 0xff) return null
    high = high * 256 + v
  }
  return (high * 256 ** lastWidthBytes + last) >>> 0
}

/** Validate an outbound URL; returns the parsed URL or a closed error. */
export function assertSafeUrl(raw: string | URL): CpResult<URL> {
  let url: URL
  try {
    url = raw instanceof URL ? raw : new URL(raw)
  } catch {
    return { ok: false, error: { code: CpErrorCode.unsafeUrl, message: 'malformed url' } }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      ok: false,
      error: { code: CpErrorCode.unsafeUrl, message: `protocol not allowed: ${url.protocol}` },
    }
  }
  if (url.username || url.password) {
    return {
      ok: false,
      error: { code: CpErrorCode.unsafeUrl, message: 'embedded credentials are not allowed' },
    }
  }
  if (!isHostAllowed(url.hostname)) {
    return {
      ok: false,
      error: { code: CpErrorCode.unsafeUrl, message: `host not allowed: ${url.hostname}` },
    }
  }
  return { ok: true, data: url }
}

export interface SafeFetchOptions {
  timeoutMs?: number | undefined
  maxRedirects?: number | undefined
  headers?: Record<string, string> | undefined
}

const SENSITIVE_REDIRECT_HEADERS =
  /^(authorization|cookie|cookie2|proxy-authorization|x-zdsh-pc-intent)$/i

/**
 * fetch wrapper that re-validates every hop (redirects are followed manually)
 * so a redirect cannot smuggle us onto a private address, and credential
 * headers are stripped the moment we leave the original origin.
 */
export async function safeFetch(
  rawUrl: string | URL,
  options: SafeFetchOptions = {},
): Promise<CpResult<{ status: number; text: string }>> {
  const maxRedirects = options.maxRedirects ?? 3
  let current = assertSafeUrl(rawUrl)
  let origin = current.ok ? current.data.origin : ''
  let headers: Record<string, string> = { ...(options.headers ?? {}) }
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!current.ok) return current
    if (current.data.origin !== origin) {
      // Cross-origin hop: credentials must not follow a redirect.
      const sanitized: Record<string, string> = {}
      for (const [key, value] of Object.entries(headers)) {
        if (!SENSITIVE_REDIRECT_HEADERS.test(key)) sanitized[key] = value
      }
      headers = sanitized
      origin = current.data.origin
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, options.timeoutMs ?? 15_000)
    try {
      const response = await fetch(current.data, {
        redirect: 'manual',
        headers,
        signal: controller.signal,
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) {
          return {
            ok: false,
            error: { code: CpErrorCode.sourceUnreachable, message: 'redirect without location' },
          }
        }
        current = assertSafeUrl(new URL(location, current.data))
        continue
      }
      const text = await response.text()
      return { ok: true, data: { status: response.status, text } }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: CpErrorCode.sourceUnreachable,
          message: error instanceof Error ? error.message : 'fetch failed',
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    ok: false,
    error: { code: CpErrorCode.sourceUnreachable, message: 'too many redirects' },
  }
}
