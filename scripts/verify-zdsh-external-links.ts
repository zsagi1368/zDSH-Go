/**
 * Probe the external URLs in the zDSH identity documents (MAIN-HYGIENE,
 * sync-017 DEBT rulings §5).
 *
 * Why this script exists: the official `verify-md-links.ts` resolves relative
 * cross-links only and *deliberately* skips scheme-qualified URLs
 * (`isExternal()`, self-documented as official design; the file is zDSH
 * zero-diff and stays that way — an overlay was ruled out because it would
 * drag the official spec surface along and pollute a pure static parser with
 * liveness semantics). The P7 incident (four dead GitHub issue links in the
 * release-notes README, caught only by human review) is the recurrence this
 * gate closes.
 *
 * Scope = zDSH author-identity documents only: root README.md / README.zh.md
 * plus packages/zdsh/**\/*.md. The official docs' huge external-link surface
 * stays the official CI's responsibility and is NOT scanned here.
 *
 * Rules (rulings §5):
 * - GET probe; HTTP 404/410 = RED (exit 1) — for public repositories the
 *   GitHub 404 verdict is reliable.
 * - 403/429/5xx, any other 4xx, malformed URL, network error, timeout, or
 *   budget exhaustion = WARN, never blocking (rate limits, bot guards, and
 *   transient failures must not produce false red).
 * - Loopback/localhost and RFC 2606 example domains are excluded from
 *   probing (documentation placeholders, not live targets).
 * - One request timeout (REQUEST_TIMEOUT_MS) plus one total budget
 *   (TOTAL_BUDGET_MS) keep the run bounded (~10s for the current ~30
 *   occurrences / ~11 unique URLs).
 * - Unique-URL probing: identical URLs across the en/zh pair are fetched
 *   once; every occurrence is reported for attribution.
 *
 * CI posture: the zdsh-ci.yml step runs with `continue-on-error: true`
 * (observation period). Promotion trigger (rulings §5.3): after 20 consecutive
 * runs or two weeks with zero false red, drop the continue-on-error and make
 * the gate blocking. Local release discipline: the P7 pre-publish checklist
 * (skill zdsh-upstream-sync, D1 card) requires this script to report 0 red
 * before any release-notes document ships — the incident surface was the
 * release paperwork itself, so the local block is the effective one.
 *
 * Run: `tsx scripts/verify-zdsh-external-links.ts` (exit 0 = no red,
 * 1 = at least one red; an uncaught usage/environment failure also exits 1).
 * @module scripts/verify-zdsh-external-links
 */

import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { Nodes } from 'mdast'
import { parseMarkdown, visitMarkdown } from './markdown.ts'
import { uniqueRepoFiles } from './repo-files.ts'

const root = resolve(import.meta.dirname, '..')

/** zDSH identity documents scanned for external URLs (rulings §5 scope). */
export const SCOPE_PATTERNS = ['README.md', 'README.zh.md', 'packages/zdsh/**/*.md'] as const

/** Per-request fetch timeout; a timeout is a WARN, never a red. */
export const REQUEST_TIMEOUT_MS = 10_000

/** Total probe budget; URLs still unprobed at exhaustion become WARN 'budget-exceeded'. */
export const TOTAL_BUDGET_MS = 90_000

/** User-Agent sent with every probe (some CDNs reject the bare node UA with a false 403). */
export const PROBE_USER_AGENT = 'zDSH-external-link-verifier (sync-017 DEBT §5 observation gate)'

/** One external-URL occurrence in one identity document. */
export interface ExternalLinkOccurrence {
  /** Repo-relative document path (forward slashes). */
  file: string
  /** 1-based line where the link/image/definition node starts. */
  line: number
  /** The URL as authored. */
  url: string
}

/** Probe plan: unique URLs in first-seen order plus their occurrences. */
export interface ProbePlan {
  /** Unique probe-target URLs, first-seen order. */
  urls: string[]
  /** Occurrences per unique URL, in document order. */
  occurrences: Map<string, ExternalLinkOccurrence[]>
}

/** Verdict classes: red blocks (exit 1), warn is recorded but never blocks. */
export type ProbeVerdict = 'ok' | 'warn' | 'red'

/** One probe outcome: an HTTP status, or a non-status failure/warn reason. */
export type ProbeOutcome =
  | { kind: 'status'; status: number }
  | { kind: 'error'; reason: string }

/**
 * Whether a link target is an external URL this gate probes: `http:`/`https:`
 * only. `mailto:` and every other scheme, protocol-relative (`//host`),
 * root-absolute (`/path`), and relative targets are not probe targets (the
 * relative face belongs to the official verify-md-links gate).
 */
export function isProbeTargetUrl(url: string): boolean {
  return /^https?:\/\//iu.test(url)
}

/**
 * Whether a hostname is a documentation placeholder that must not be probed:
 * loopback (127.0.0.0/8, ::1), `localhost`, `0.0.0.0`, and the RFC 2606 /
 * RFC 6761 reserved example domains (example.com/org/net/edu, their
 * subdomains, and the reserved `.example` TLD).
 */
export function isExcludedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '0.0.0.0') return true
  if (host === '[::1]' || host === '::1') return true
  if (host === '127.0.0.1' || host.startsWith('127.')) return true
  if (host === 'example' || host.endsWith('.example')) return true
  return ['example.com', 'example.org', 'example.net', 'example.edu'].some(
    reserved => host === reserved || host.endsWith(`.${reserved}`),
  )
}

/**
 * Classify one HTTP status: 404/410 = red (dead link; reliable for public
 * repositories); 403/429/5xx = warn (rate limit / bot guard / server fault —
 * never block on these); any OTHER 4xx = warn as well (401/451/… are
 * anti-bot or legal-block postures, not evidence of a dead link); everything
 * else (2xx/3xx) = ok.
 */
export function classifyStatus(status: number): ProbeVerdict {
  if (status === 404 || status === 410) return 'red'
  if (status >= 400) return 'warn'
  return 'ok'
}

/**
 * Extract every external-URL occurrence from one Markdown source via its AST
 * (link, image, and definition nodes — the same node face the official
 * verify-md-links walks). Code fences and inline code never produce these
 * nodes, so example URLs inside code are naturally out of scope.
 * @param source - the document's full Markdown text.
 * @param file - repo-relative path recorded on each occurrence.
 * @returns occurrences in document order.
 */
export function externalLinksInSource(source: string, file: string): ExternalLinkOccurrence[] {
  const out: ExternalLinkOccurrence[] = []
  visitMarkdown(parseMarkdown(source), (node: Nodes): void => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && 'url' in node) {
      if (isProbeTargetUrl(node.url)) {
        out.push({ file, line: node.position?.start.line ?? 0, url: node.url })
      }
    }
  })
  return out
}

/** Read one identity document and extract its external-URL occurrences. */
export function externalLinkOccurrences(absPath: string, scanRoot: string = root): ExternalLinkOccurrence[] {
  const file = relative(scanRoot, absPath).replaceAll('\\', '/')
  return externalLinksInSource(readFileSync(absPath, 'utf8'), file)
}

/**
 * The zDSH identity documents in scope, repo-relative with forward slashes,
 * in stable first-seen order (symlink-deduplicated like every repo gate).
 */
export function identityDocPaths(scanRoot: string = root): string[] {
  return uniqueRepoFiles(scanRoot, SCOPE_PATTERNS)
    .map(file => relative(scanRoot, file.abs).replaceAll('\\', '/'))
}

/**
 * Collapse occurrences into the probe plan: one entry per unique URL (exact
 * string key — the en/zh pair shares every URL, so the identity surface
 * costs one fetch per link), first-seen order, occurrences grouped per URL.
 */
export function planProbes(occurrences: readonly ExternalLinkOccurrence[]): ProbePlan {
  const grouped = new Map<string, ExternalLinkOccurrence[]>()
  for (const occurrence of occurrences) {
    const bucket = grouped.get(occurrence.url)
    if (bucket === undefined) grouped.set(occurrence.url, [occurrence])
    else bucket.push(occurrence)
  }
  return { urls: [...grouped.keys()], occurrences: grouped }
}

/**
 * Probe one URL with a single GET (redirects followed): resolve to the final
 * HTTP status, or to a non-status warn reason (malformed URL, network error,
 * timeout). Never throws and never blocks on the network longer than
 * `timeoutMs`.
 */
export async function probeUrl(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<ProbeOutcome> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return { kind: 'error', reason: 'malformed URL' }
  }
  if (isExcludedHost(target.hostname)) {
    return { kind: 'error', reason: `excluded placeholder host (${target.hostname})` }
  }
  try {
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': PROBE_USER_AGENT, accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    // Release the socket without downloading bodies this gate never reads.
    await response.body?.cancel()
    return { kind: 'status', status: response.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = /timeout|aborted/iu.test(message) ? `timeout after ${String(timeoutMs)}ms` : `network error (${message})`
    return { kind: 'error', reason }
  }
}

/** Verdict of one outcome: statuses classify; every non-status outcome warns. */
export function verdictOf(outcome: ProbeOutcome): ProbeVerdict {
  return outcome.kind === 'status' ? classifyStatus(outcome.status) : 'warn'
}

/** Describe one outcome for the report line. */
function describeOutcome(outcome: ProbeOutcome): string {
  return outcome.kind === 'status' ? String(outcome.status) : outcome.reason
}

async function main(): Promise<number> {
  const docs = identityDocPaths(root)
  const occurrences = docs.flatMap(doc => externalLinkOccurrences(resolve(root, doc), root))
  const plan = planProbes(occurrences)
  const deadline = Date.now() + TOTAL_BUDGET_MS

  let red = 0
  let warn = 0
  let ok = 0
  for (const url of plan.urls) {
    const sites = plan.occurrences.get(url) ?? []
    const where = sites.map(site => `${site.file}:${String(site.line)}`).join(', ')
    const outcome: ProbeOutcome = Date.now() > deadline
      ? { kind: 'error', reason: 'budget-exceeded (total probe budget exhausted; not probed)' }
      : await probeUrl(url)
    const verdict = verdictOf(outcome)
    if (verdict === 'red') red += 1
    else if (verdict === 'warn') warn += 1
    else ok += 1
    const line = `${verdict.toUpperCase()} ${url} (${describeOutcome(outcome)}) <- ${where}`
    if (verdict === 'red') console.error(line)
    else console.log(line)
  }

  const summary = `verify-zdsh-external-links: ${String(docs.length)} identity doc(s), ${String(occurrences.length)} occurrence(s), ${String(plan.urls.length)} unique URL(s): ${String(ok)} ok, ${String(warn)} warn, ${String(red)} red.`
  if (red > 0) {
    console.error(summary)
    console.error('Red = dead link (404/410) in a zDSH identity document: fix the document. Warn never blocks (rate limit / bot guard / transient).')
    return 1
  }
  console.log(summary)
  return 0
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  process.exitCode = await main()
}
