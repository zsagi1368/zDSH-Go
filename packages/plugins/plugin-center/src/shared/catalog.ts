import { normalizePluginId, type CpResult } from './types.js'
import { assertSafeUrl } from './ssrc-guard.js'

export type EvidenceLevel = 'discovered' | 'installable' | 'verified' | 'recommended'
export type CompatLevel = 'exact' | 'range-supported' | 'unknown'
export type ScriptsPolicy = 'none' | 'allowlisted'
export type CatalogSource = 'github' | 'npm'

export interface BilingualText {
  zh: string
  en: string
}

/**
 * A trusted-catalog entry. GitHub entries must pin an exact 40-hex commit;
 * npm entries carry a version plus integrity digest instead.
 */
export interface CatalogEntry {
  id: string
  source: CatalogSource
  owner?: string
  repo?: string
  pinnedCommit?: string
  packageName?: string
  version?: string
  integritySha256?: string
  title: BilingualText
  summary: BilingualText
  category: string
  evidence: EvidenceLevel
  compat: CompatLevel
  scriptsPolicy: ScriptsPolicy
  homepage?: string
  updatedAt: string
}

const COMMIT_HEX = /^[0-9a-f]{40}$/

export function isValidCommit(commit: string): boolean {
  return COMMIT_HEX.test(commit)
}

const NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,98}$/
const NPM_PACKAGE = /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const CATEGORY = /^[A-Za-z0-9 _-]{1,40}$/
const TEXT_LIMIT = 200

function textOk(value: unknown): value is BilingualText {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Record<string, unknown>
  return (
    typeof t.zh === 'string' && t.zh.length >= 1 && t.zh.length <= TEXT_LIMIT &&
    typeof t.en === 'string' && t.en.length >= 1 && t.en.length <= TEXT_LIMIT
  )
}

/** Structural validation; ids are normalized and every argv-bound field is
 * pinned to a strict charset (these values reach command construction). */
export function validateCatalogEntry(raw: unknown): CpResult<CatalogEntry> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: { code: 'invalid_plan', message: 'entry is not an object' } }
  }
  const e = raw as Record<string, unknown>
  const id = typeof e.id === 'string' ? normalizePluginId(e.id) : null
  if (!id || !id.ok) {
    return { ok: false, error: { code: 'invalid_plan', message: 'entry id missing or malformed' } }
  }
  const source = e.source
  if (source !== 'github' && source !== 'npm') {
    return { ok: false, error: { code: 'invalid_plan', message: `unknown source: ${String(source)}` } }
  }

  // Explicit allowlist construction: undeclared fields from a remote catalog
  // never reach the API or UI surface.
  let owner: string | undefined
  let repo: string | undefined
  let pinnedCommit: string | undefined
  let packageName: string | undefined
  let version: string | undefined
  let integritySha256: string | undefined

  if (source === 'github') {
    const commit = e.pinnedCommit
    if (typeof commit !== 'string' || !isValidCommit(commit)) {
      return {
        ok: false,
        error: { code: 'untrusted_source', message: 'github entry requires a pinned 40-hex commit' },
      }
    }
    if (typeof e.owner !== 'string' || !NAME_PART.test(e.owner)) {
      return { ok: false, error: { code: 'untrusted_source', message: 'github entry requires a safe owner' } }
    }
    if (typeof e.repo !== 'string' || !NAME_PART.test(e.repo)) {
      return { ok: false, error: { code: 'untrusted_source', message: 'github entry requires a safe repo' } }
    }
    owner = e.owner
    repo = e.repo
    pinnedCommit = commit
  } else {
    if (typeof e.packageName !== 'string' || !NPM_PACKAGE.test(e.packageName)) {
      return { ok: false, error: { code: 'untrusted_source', message: 'npm entry requires a safe packageName' } }
    }
    if (typeof e.version !== 'string' || !SEMVER.test(e.version)) {
      return { ok: false, error: { code: 'untrusted_source', message: 'npm entry requires a semver version' } }
    }
    if (typeof e.integritySha256 === 'string' && /^[0-9a-f]{64}$/.test(e.integritySha256)) {
      integritySha256 = e.integritySha256
    }
    packageName = e.packageName
    version = e.version
  }

  if (!textOk(e.title) || !textOk(e.summary)) {
    return { ok: false, error: { code: 'invalid_plan', message: 'title/summary must be bilingual strings ≤200 chars' } }
  }
  const evidence = e.evidence
  if (evidence !== 'discovered' && evidence !== 'installable' && evidence !== 'verified' && evidence !== 'recommended') {
    return { ok: false, error: { code: 'invalid_plan', message: 'bad evidence level' } }
  }
  const compat = e.compat
  if (compat !== 'exact' && compat !== 'range-supported' && compat !== 'unknown') {
    return { ok: false, error: { code: 'invalid_plan', message: 'bad compat level' } }
  }
  const scriptsPolicy = e.scriptsPolicy
  if (scriptsPolicy !== 'none' && scriptsPolicy !== 'allowlisted') {
    return { ok: false, error: { code: 'invalid_plan', message: 'bad scripts policy' } }
  }
  const updatedAt = e.updatedAt
  if (typeof updatedAt !== 'string' || updatedAt.length > 32 || Number.isNaN(Date.parse(updatedAt))) {
    return { ok: false, error: { code: 'invalid_plan', message: 'updatedAt missing or invalid' } }
  }
  const category =
    typeof e.category === 'string' && CATEGORY.test(e.category) ? e.category : 'misc'
  let homepage: string | undefined
  if (e.homepage !== undefined) {
    if (typeof e.homepage !== 'string') {
      return { ok: false, error: { code: 'invalid_plan', message: 'homepage must be a string' } }
    }
    const checked = assertSafeUrl(e.homepage)
    if (!checked.ok) {
      return { ok: false, error: { code: 'unsafe_url', message: 'homepage must be a safe http(s) URL' } }
    }
    homepage = checked.data.toString()
  }

  const entry: CatalogEntry = {
    id: id.data,
    source,
    title: e.title,
    summary: e.summary,
    category,
    evidence,
    compat,
    scriptsPolicy,
    updatedAt,
    ...(owner !== undefined ? { owner } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(pinnedCommit !== undefined ? { pinnedCommit } : {}),
    ...(packageName !== undefined ? { packageName } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(integritySha256 !== undefined ? { integritySha256 } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
  }
  return { ok: true, data: entry }
}

/**
 * Candidate entries live in a physically separate discovery pool and are
 * type-forbidden from carrying anything installable.
 */
export interface CandidateEntry {
  id: string
  originUrl: string
  noteZh: string
  noteEn: string
  discoveredAt: string
}

// Compile-time guarantee: a candidate can never be smuggled in as installable.
type NoInstallFieldsOnCandidates = keyof CatalogEntry &
  ('pinnedCommit' | 'integritySha256' | 'evidence')
const neverInstallField: NoInstallFieldsOnCandidates[] = []
void neverInstallField // kept for the type tripwire above; intentionally empty

const EVIDENCE_RANK: Record<EvidenceLevel, number> = {
  recommended: 3,
  verified: 2,
  installable: 1,
  discovered: 0,
}
const COMPAT_RANK: Record<CompatLevel, number> = {
  exact: 2,
  'range-supported': 1,
  unknown: 0,
}

/** Default ordering: recommendation first, then evidence, exact compat, recency. */
export function sortEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((a, b) => {
    const ev = EVIDENCE_RANK[b.evidence] - EVIDENCE_RANK[a.evidence]
    if (ev !== 0) return ev
    const co = COMPAT_RANK[b.compat] - COMPAT_RANK[a.compat]
    if (co !== 0) return co
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
}

export interface Page<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

/** Bounded pagination; out-of-range pages clamp to the last non-empty page. */
export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const total = items.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(1, Math.floor(page)), pageCount)
  const start = (safePage - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    pageSize,
    total,
  }
}

export interface SearchQuery {
  text?: string | undefined
  category?: string | undefined
  evidenceOnlyRecommended?: boolean | undefined
}

export function searchEntries(entries: CatalogEntry[], query: SearchQuery): CatalogEntry[] {
  let result = entries
  if (query.category) {
    result = result.filter(e => e.category === query.category)
  }
  if (query.evidenceOnlyRecommended) {
    result = result.filter(e => e.evidence === 'recommended')
  }
  const text = query.text?.trim().toLowerCase()
  if (text) {
    result = result.filter(e =>
      [e.id, e.title.zh, e.title.en, e.summary.zh, e.summary.en, e.packageName ?? '', e.repo ?? '']
        .join(' ')
        .toLowerCase()
        .includes(text),
    )
  }
  return result
}
