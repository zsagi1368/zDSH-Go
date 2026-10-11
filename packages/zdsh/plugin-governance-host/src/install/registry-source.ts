/**
 * Minimal npm-registry client for plugin admission installs. Security
 * posture: HTTPS only, a single allow-listed registry origin (every redirect
 * hop must stay on it), hard response-size caps, and mandatory sha512
 * integrity verification of the publish tarball against the version
 * manifest's `dist.integrity`. Exact versions only — range solving would add
 * resolution ambiguity to an admission decision.
 * @module
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** One rejected or failed registry interaction. */
export class NpmSourceError extends Error {
  /** Machine-readable category mirrored into GovernanceErrorCode. */
  readonly kind: 'invalid' | 'not-found' | 'unavailable'

  constructor(kind: 'invalid' | 'not-found' | 'unavailable', message: string) {
    super(message)
    this.name = 'NpmSourceError'
    this.kind = kind
  }
}

/** Default upstream; overridable per gateway config for mirrors/proxies. */
export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'

/**
 * Parse and validate a configured registry URL down to its HTTPS origin.
 * @param raw - the configured registry URL to validate.
 * @returns the normalized bare HTTPS origin of the registry.
 */
export function registryOriginFromConfig(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new NpmSourceError('invalid', `registryUrl ${JSON.stringify(raw)} is not a URL`)
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0 || parsed.password.length > 0
    || parsed.pathname.length > 1
    || parsed.search.length > 0 || parsed.hash.length > 0
  ) {
    throw new NpmSourceError('invalid', 'registryUrl must be a bare https origin such as https://registry.npmjs.org')
  }
  return parsed.origin
}

/** Parsed `npm:<name>[@<exact-version>]` install source. */
export interface NpmSpec {
  readonly name: string
  readonly version?: string
}

const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

/**
 * Split an `npm:` install source into package name and optional exact
 * version. Range specifiers are rejected: an admission decision should pin
 * what it admits.
 * @param source - the install source string to parse.
 * @returns the parsed name and optional exact version, or `null` when the
 * source is not a valid exact `npm:` reference.
 */
export function parseNpmSpec(source: string): NpmSpec | null {
  if (!source.startsWith('npm:')) return null
  const rest = source.slice('npm:'.length).trim()
  const atSign = rest.lastIndexOf('@')
  let name = rest
  let version: string | undefined
  // A leading '@' belongs to the scope separator, not a version delimiter.
  if (atSign > (rest.startsWith('@') ? 0 : -1)) {
    name = rest.slice(0, atSign)
    version = rest.slice(atSign + 1)
  }
  if (!NPM_NAME.test(name)) return null
  if (version === undefined) return { name }
  if (!EXACT_VERSION.test(version)) return null
  return { name, version }
}

/** Resolved location of one publishable release. */
export interface RegistryVersion {
  readonly version: string
  readonly tarballUrl: string
  readonly integrity: string
}

/**
 * HTTP surface shared by both calls: manual redirects so every hop can be
 * re-validated against the registry origin, and a hard timeout.
 */
export interface HttpLike {
  (url: string, init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }): Promise<Response>
}

/** Follow at most three redirects, each of which must stay on the origin. */
async function requestWithinOrigin(
  http: HttpLike,
  url: string,
  origin: string,
  headers: Record<string, string>,
): Promise<Response> {
  let current = url
  for (let hops = 0; ; hops += 1) {
    let target: URL
    try {
      target = new URL(current)
    } catch {
      throw new NpmSourceError('unavailable', 'the registry returned a malformed redirect target')
    }
    if (target.protocol !== 'https:' || target.origin !== origin) {
      throw new NpmSourceError('unavailable', 'a registry redirect left the configured registry origin')
    }
    const response = await http(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers,
    }).catch((cause: unknown) => {
      throw new NpmSourceError('unavailable', `the registry could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null) throw new NpmSourceError('unavailable', 'a registry redirect carried no Location header')
      if (hops >= 3) throw new NpmSourceError('unavailable', 'too many registry redirects')
      current = new URL(location, current).toString()
      continue
    }
    return response
  }
}

/** Read a capped JSON body; larger responses are refused before parsing. */
async function readCappedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declared) && declared > maxBytes) throw new NpmSourceError('unavailable', 'the registry metadata exceeds the size cap')
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new NpmSourceError('unavailable', 'the registry metadata exceeds the size cap')
  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new NpmSourceError('unavailable', `registry metadata was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Highest stable (non-prerelease) semver among the packument's versions. */
function highestStableVersion(versions: Record<string, unknown>): string | undefined {
  let best: { id: string; parts: [number, number, number] } | undefined
  for (const candidate of Object.keys(versions)) {
    // String#match keeps this free of any command-executor lookalike call.
    const match = candidate.match(/^(\d+)\.(\d+)\.(\d+)$/u)
    if (match === null) continue
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number]
    if (
      best === undefined
      || parts[0] > best.parts[0]
      || (parts[0] === best.parts[0] && parts[1] > best.parts[1])
      || (parts[0] === best.parts[0] && parts[1] === best.parts[1] && parts[2] > best.parts[2])
    ) {
      best = { id: candidate, parts }
    }
  }
  return best?.id
}

/**
 * Resolve one spec against the registry packument and return the chosen
 * version's tarball location and expected sha512 digest.
 * @param origin - the allow-listed HTTPS registry origin to query.
 * @param spec - the exact `npm:` spec to resolve.
 * @param http - the fetch-like HTTP surface to use; defaults to global fetch.
 * @returns the chosen version with its tarball URL and sha512 integrity digest.
 */
export async function resolveRegistryVersion(
  origin: string,
  spec: NpmSpec,
  http: HttpLike = (globalThis as { fetch: HttpLike }).fetch,
): Promise<RegistryVersion> {
  const encoded = spec.name.replace(/^@/u, '').split('/').map(encodeURIComponent).join('/')
  const metadataPath = ['/', encoded].join('')
  const response = await requestWithinOrigin(http, new URL(metadataPath, origin).toString(), origin, { accept: 'application/json' })
  if (response.status === 404) throw new NpmSourceError('not-found', ['no package', JSON.stringify(spec.name), 'on this registry'].join(' '))
  if (!response.ok) {
    throw new NpmSourceError('unavailable', ['the registry responded with status', String(response.status)].join(' '))
  }
  const packument = await readCappedJson(response, 5 * 1024 * 1024)
  if (typeof packument !== 'object' || packument === null) throw new NpmSourceError('unavailable', 'registry metadata was not an object')
  const versions = (packument as Record<string, unknown>).versions
  if (typeof versions !== 'object' || versions === null) throw new NpmSourceError('unavailable', 'registry metadata carries no versions map')
  const chosenId = pickVersion(packument as Record<string, unknown>, versions as Record<string, unknown>, spec)
  const manifest = (versions as Record<string, unknown>)[chosenId]
  if (typeof manifest !== 'object' || manifest === null) throw new NpmSourceError('unavailable', 'the resolved version manifest was malformed')
  const dist = (manifest as Record<string, unknown>).dist
  const distView = typeof dist === 'object' && dist !== null ? dist as Record<string, unknown> : undefined
  const rawTarball: unknown = distView === undefined ? undefined : distView.tarball
  const rawIntegrity: unknown = distView === undefined ? undefined : distView.integrity
  const tarballUrl = typeof rawTarball === 'string' ? rawTarball : undefined
  const integrity = typeof rawIntegrity === 'string' ? rawIntegrity : undefined
  if (tarballUrl === undefined || integrity === undefined || !/^sha512-[A-Za-z0-9+/=]+$/u.test(integrity)) {
    throw new NpmSourceError('unavailable', 'the resolved version names no tarball or carries no sha512 integrity digest')
  }
  return { version: chosenId, tarballUrl, integrity }
}

/** Exact version first; otherwise the `latest` tag or the highest stable. */
function pickVersion(
  packument: Record<string, unknown>,
  versions: Record<string, unknown>,
  spec: NpmSpec,
): string {
  if (spec.version !== undefined) {
    if (!Object.hasOwn(versions, spec.version)) {
      throw new NpmSourceError('not-found', `version ${JSON.stringify(spec.version)} of ${JSON.stringify(spec.name)} does not exist`)
    }
    return spec.version
  }
  const tags = typeof packument.dist_tags === 'object' && packument.dist_tags !== null
    ? packument.dist_tags as Record<string, unknown>
    : {}
  const latest = tags.latest
  if (typeof latest === 'string' && Object.hasOwn(versions, latest)) return latest
  const highest = highestStableVersion(versions)
  if (highest !== undefined) return highest
  throw new NpmSourceError('not-found', 'no stable release of this package exists')
}

/**
 * Whether `buffer` matches one declared `sha512-<base64>` integrity digest
 * (constant-time comparison, same grammar as the download verification).
 * Exported for the seed chain's independent pin check (FB6, TC-B4-H1 face 5):
 * a downloaded tarball is already verified against the REGISTRY's own
 * `dist.integrity` (correct inside the npm trust model, but a same-channel
 * self-attestation); a seed-pinned digest is a second, independently declared
 * value the bytes must also satisfy before a boot-time install is admitted.
 * @param buffer - the downloaded tarball bytes.
 * @param integrity - the declared `sha512-…` digest value.
 * @returns `true` only when the digest is well-formed AND matches the buffer.
 */
export function matchesSha512Integrity(buffer: Buffer, integrity: string): boolean {
  const digest = integrity.match(/^sha512-([A-Za-z0-9+/=]+)$/u)
  if (digest === null || digest[1] === undefined) return false
  const expected = Buffer.from(digest[1], 'base64')
  const actual = createHash('sha512').update(buffer).digest()
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * Download the publish tarball with size caps and verify it against the
 * registry's declared sha512 digest. The buffer is only returned when
 * verification passed.
 * @param origin - the allow-listed HTTPS registry origin to download from.
 * @param resolved - the resolved release to download.
 * @param maxBytes - hard cap on the accepted tarball size.
 * @param http - the fetch-like HTTP surface to use; defaults to global fetch.
 * @returns the downloaded tarball buffer, verified against the declared digest.
 */
export async function downloadVerifiedTarball(
  origin: string,
  resolved: RegistryVersion,
  maxBytes: number,
  http: HttpLike = (globalThis as { fetch: HttpLike }).fetch,
): Promise<Buffer> {
  const response = await requestWithinOrigin(http, resolved.tarballUrl, origin, { accept: '*/*' })
  if (!response.ok) {
    throw new NpmSourceError('unavailable', ['the tarball download responded with status', String(response.status)].join(' '))
  }
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declared) && declared > maxBytes) throw new NpmSourceError('unavailable', 'the tarball exceeds the size cap')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) throw new NpmSourceError('unavailable', 'the tarball exceeds the size cap')
  const digest = resolved.integrity.match(/^sha512-([A-Za-z0-9+/=]+)$/u)
  if (digest === null || digest[1] === undefined) {
    throw new NpmSourceError('unavailable', 'the integrity digest is not a base64 sha512 value')
  }
  const expected = Buffer.from(digest[1], 'base64')
  const actual = createHash('sha512').update(buffer).digest()
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new NpmSourceError('unavailable', 'the tarball does not match its published sha512 integrity digest')
  }
  return buffer
}
