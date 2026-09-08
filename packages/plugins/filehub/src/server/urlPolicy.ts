/**
 * M4 vision URL policy (P01 §6-D, FR-D2/D4): the two hard security fences of
 * the caption waterfall.
 *
 * - {@link assertLocalLoopbackUrl} locks the local Ollama probe TO the loopback
 *   (127.0.0.1 / ::1 / ::ffff:127.0.0.1 unwrapped / localhost, any port). This
 *   is a reverse lock: a hostile `vision.ollamaEndpoint` configuration must
 *   never turn the probe into an intranet-lateral scanner, so anything that
 *   does not normalize into the loopback set throws.
 * - {@link assertPublicHttpUrl} locks the explicit outbound endpoint to the
 *   PUBLIC internet: http/https only; localhost, loopback (127/8, ::1,
 *   ::ffff:-mapped re-checked after unwrap), RFC1918, CGNAT 100.64/10,
 *   link-local 169.254/16 and fe80::/10, 0.0.0.0/8, benchmarking 198.18/15,
 *   reserved 240/4, multicast/reserved v4, v4-mapped / IPv4-compatible v6,
 *   unique-local and site-local v6 are all rejected. Decimal-integer and
 *   octal/hex IP spellings are NORMALIZED before classification (a classic
 *   SSRF bypass), and non-literal hostnames are DNS-resolved with every
 *   answer re-classified (DNS-rebinding defense: an A record pointing at a
 *   private address fails closed).
 *
 * Violations throw {@link UrlPolicyError}; the waterfall treats a throw as
 * "skip this level + warn", never as a global failure.
 */

import dns from 'node:dns'

/** Thrown on every policy violation; the waterfall maps it to skip+warn. */
export class UrlPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UrlPolicyError'
  }
}

// ---------------------------------------------------------------------------
// Address normalization + classification
// ---------------------------------------------------------------------------

/** Classification buckets shared by both guards. */
export type IpClass =
  | 'unspecified'
  | 'thisNetwork'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'linkLocal'
  | 'benchmark'
  | 'multicast'
  | 'reserved'
  | 'ula'
  | 'siteLocal'
  | 'public'

/** One parsed IP after normalization: canonical dotted quad or 8 hex groups. */
type NormalizedIp = { kind: 'v4'; ip: string } | { kind: 'v6'; groups: number[] }

/**
 * Parse one dotted-IPv4 spelling with inet_aton-style shorthand: parts may be
 * decimal, leading-zero octal (`0177`), or `0x` hex; one/two/three-part forms
 * pad the tail (`127.1` → `127.0.0.1`). Returns undefined when any part is not
 * numeric (the host is a name, not an IP spelling); throws when numeric but
 * out of range (fail closed — a malformed numeric trick must never pass).
 */
function normalizeDottedIpv4(host: string): NormalizedIp | undefined {
  const parts = host.split('.')
  if (parts.length === 0 || parts.length > 4) return undefined
  const values: number[] = []
  for (const part of parts) {
    let value: number | null = null
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part, 16)
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8)
    else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10)
    if (value === null) return undefined // non-numeric part → hostname
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new UrlPolicyError(`invalid numeric IP component "${part}"`)
    }
    values.push(value)
  }
  let bytes: number[]
  if (values.length === 4) {
    bytes = values
    if (bytes.some(value => value > 0xff)) {
      throw new UrlPolicyError(`invalid IPv4 quad "${host}"`)
    }
  } else {
    // Shorthand: every part but the last owns one byte; the last part fills
    // the remaining width big-endian (`127.1` → 127 . 0 . 0 . 1).
    const head = values.slice(0, -1)
    const tail = values[values.length - 1] ?? 0
    const remainingBytes = 4 - head.length
    const maxTail = 2 ** (8 * remainingBytes) - 1
    if (head.some(value => value > 0xff) || tail > maxTail) {
      throw new UrlPolicyError(`invalid shorthand IPv4 "${host}"`)
    }
    bytes = [...head]
    for (let shift = 8 * (remainingBytes - 1); shift >= 0; shift -= 8) {
      bytes.push((tail >>> shift) & 0xff)
    }
  }
  return { kind: 'v4', ip: bytes.join('.') }
}

/** Expand an IPv6 literal into eight 16-bit groups (handles `::` + v4 tail). */
function expandIpv6(host: string): NormalizedIp | undefined {
  let text = host.toLowerCase()
  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1): normalize the quad to two hex
  // groups first so the generic expansion below sees one uniform shape.
  const lastColon = text.lastIndexOf(':')
  if (text.includes('.', lastColon + 1)) {
    const normalizedTail = normalizeDottedIpv4(text.slice(lastColon + 1))
    if (normalizedTail === undefined || normalizedTail.kind !== 'v4') return undefined
    const bytes = normalizedTail.ip.split('.').map(value => Number.parseInt(value, 10))
    const high = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)
    const low = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] === '' ? [] : (halves[0] ?? '').split(':')
  const right =
    halves.length === 2 && halves[1] !== '' ? (halves[1] ?? '').split(':') : []
  if (halves.length === 1 && left.length !== 8) return undefined
  if (halves.length === 2 && left.length + right.length > 7) return undefined
  const fill = 8 - left.length - right.length
  const groups: number[] = []
  for (const chunk of [...left, ...Array<string>(Math.max(0, fill)).fill('0'), ...right]) {
    if (!/^[0-9a-f]{1,4}$/.test(chunk)) return undefined
    groups.push(Number.parseInt(chunk, 16))
  }
  if (groups.length !== 8) return undefined
  return { kind: 'v6', groups }
}

function classifyIpv4(ip: string): IpClass {
  const bytes = ip.split('.').map(value => Number.parseInt(value, 10))
  const b0 = bytes[0] ?? 0
  const b1 = bytes[1] ?? 0
  if (b0 === 0) return 'thisNetwork' // 0.0.0.0/8 ("this network", incl. 0.0.0.0)
  if (b0 === 10) return 'private' // RFC1918
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return 'cgnat' // 100.64/10
  if (b0 === 127) return 'loopback' // 127/8
  if (b0 === 169 && b1 === 254) return 'linkLocal' // 169.254/16
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return 'private' // 172.16/12
  if (b0 === 192 && b1 === 168) return 'private' // 192.168/16
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return 'benchmark' // 198.18/15
  if (b0 >= 224 && b0 <= 239) return 'multicast' // 224/4
  if (b0 >= 240) return 'reserved' // 240/4 incl. 255.255.255.255
  return 'public'
}

function classifyGroups(groups: readonly number[]): IpClass {
  const g0 = groups[0] ?? 0
  // ::1 (any spelling, compressed or not) before anything else.
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return 'loopback'
  if (groups.every(group => group === 0)) return 'unspecified' // ::
  // ::ffff:0:0/96 mapped AND the legacy ::/96-compatible form both hide a v4
  // address in the low 32 bits — unwrap and RE-classify as v4 (spec: 复检).
  if (groups.slice(0, 5).every(group => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    const wordA = groups[6] ?? 0
    const wordB = groups[7] ?? 0
    const v4 = `${wordA >> 8}.${wordA & 0xff}.${wordB >> 8}.${wordB & 0xff}`
    return classifyIpv4(v4)
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'ula' // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return 'linkLocal' // fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return 'siteLocal' // fec0::/10 (deprecated)
  if ((g0 & 0xff00) === 0xff00) return 'multicast' // ff00::/8
  return 'public'
}

/** Classify any already-normalized address. */
function classify(ip: NormalizedIp): IpClass {
  return ip.kind === 'v4' ? classifyIpv4(ip.ip) : classifyGroups(ip.groups)
}

// ---------------------------------------------------------------------------
// Host parsing helpers
// ---------------------------------------------------------------------------

/** Validate scheme + parse; both guards only ever speak http/https. */
function parseHttpUrl(input: string | URL): URL {
  let url: URL
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input)
  } catch {
    throw new UrlPolicyError(`malformed vision endpoint URL: ${String(input)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlPolicyError(`vision endpoint scheme must be http/https, got "${url.protocol}"`)
  }
  return url
}

/** Lower-cased hostname with brackets stripped (WHATWG keeps them on IPv6). */
export function hostnameOf(url: URL): string {
  let host = url.hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1) // FQDN trailing dot
  return host
}

/**
 * Normalize a host into an address when it is an IP literal (any numeric
 * spelling); returns undefined for plain hostnames. Throws UrlPolicyError on
 * malformed numerics (fail closed).
 */
function normalizeHostOrUndefined(host: string): NormalizedIp | undefined {
  if (host.includes(':')) {
    const expanded = expandIpv6(host)
    if (expanded === undefined) throw new UrlPolicyError(`malformed IPv6 literal "${host}"`)
    return expanded
  }
  return normalizeDottedIpv4(host)
}

// ---------------------------------------------------------------------------
// Guard 1: local Ollama probe — reverse lock onto the loopback
// ---------------------------------------------------------------------------

/**
 * The sanctioned probe targets, post-normalization: 127.0.0.1 exactly (so its
 * decimal/octal/hex spellings collapse onto it), ::1, and ::ffff:127.0.0.1
 * (mapped or legacy-compatible spelling, unwrapped). Nothing else — a hostile
 * ollamaEndpoint must never widen the probe into intranet-lateral scanning.
 */
function isSanctionedLoopback(ip: NormalizedIp): boolean {
  if (ip.kind === 'v4') return ip.ip === '127.0.0.1'
  const groups = ip.groups
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true // ::1
  if (groups.slice(0, 5).every(group => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return groups[6] === 0x7f00 && groups[7] === 0x0001 // ::ffff:127.0.0.1
  }
  return false
}

/**
 * Assert that `input` targets the local machine: hostname `localhost`, or an
 * IP literal inside the sanctioned loopback set above. Any other target
 * throws. Ports are unrestricted on purpose — the probe may use any port.
 */
export function assertLocalLoopbackUrl(input: string | URL): URL {
  const url = parseHttpUrl(input)
  const host = hostnameOf(url)
  if (host === 'localhost') return url
  const normalized = normalizeHostOrUndefined(host)
  if (normalized !== undefined && isSanctionedLoopback(normalized)) return url
  throw new UrlPolicyError(
    `vision Ollama probe must stay on the loopback (127.0.0.1/::1/localhost), got "${url.host}"`,
  )
}

// ---------------------------------------------------------------------------
// Guard 2: explicit outbound endpoint — public internet only
// ---------------------------------------------------------------------------

/** Injectable DNS shape (tests mock this to simulate rebinding). */
export type LookupAllAddresses = (hostname: string) => Promise<Array<{ address: string; family: number }>>

const defaultLookup: LookupAllAddresses = hostname => dns.promises.lookup(hostname, { all: true })

export interface PublicHttpUrlOptions {
  /** Override DNS resolution (tests). Defaults to node dns.lookup(all:true). */
  lookup?: LookupAllAddresses | undefined
}

function rejectIfNotPublic(address: NormalizedIp, origin: string): void {
  const klass = classify(address)
  if (klass !== 'public') {
    throw new UrlPolicyError(
      `vision endpoint "${origin}" resolves to a non-public address (${klass}); refused`,
    )
  }
}

/**
 * Assert that `input` is a safe OUTBOUND target: http/https, no localhost, no
 * loopback/private/reserved/mapped address under ANY spelling, and — for real
 * hostnames — no DNS answer landing in those ranges (rebinding defense:
 * EVERY resolved address must be public or the call fails closed).
 */
export async function assertPublicHttpUrl(
  input: string | URL,
  options?: PublicHttpUrlOptions,
): Promise<URL> {
  const url = parseHttpUrl(input)
  const host = hostnameOf(url)
  if (host === 'localhost' || host === 'localhost.localdomain') {
    throw new UrlPolicyError(`vision endpoint must not target localhost ("${url.host}")`)
  }
  const normalized = normalizeHostOrUndefined(host)
  if (normalized !== undefined) {
    rejectIfNotPublic(normalized, url.host)
    return url
  }
  const lookup = options?.lookup ?? defaultLookup
  let answers: Array<{ address: string; family: number }>
  try {
    answers = await lookup(host)
  } catch (error: unknown) {
    throw new UrlPolicyError(
      `vision endpoint "${url.host}" could not be resolved (failing closed): ${String(error)}`,
    )
  }
  if (answers.length === 0) {
    throw new UrlPolicyError(`vision endpoint "${url.host}" resolved to no addresses; refused`)
  }
  for (const answer of answers) {
    const address = normalizeHostOrUndefined(answer.address.toLowerCase())
    if (address === undefined) {
      throw new UrlPolicyError(`resolver returned a non-address "${answer.address}" for ${url.host}`)
    }
    rejectIfNotPublic(address, url.host)
  }
  return url
}
