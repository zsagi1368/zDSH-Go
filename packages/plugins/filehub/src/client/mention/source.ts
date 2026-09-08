/**
 * `@` trigger source registration over the host input-trigger pipeline.
 *
 * Host facts this encodes (verified against the shipped Fork):
 * - Sources register via `ctx.inputTriggers.registerSource(src)`; the
 *   (trigger, name) pair must be unique and duplicate registration throws
 *   (Fork/packages/client/ui-input-trigger/lib/types/client/contract.d.ts;
 *    service.d.ts registerSource doc).
 * - InputTriggerSource shape: { trigger, name, order?, showGroupTitle?,
 *   candidates(session, req), onPick(pick), matchSpace?, matchEnter?, warm?,
 *   lexicon?, subscribeLexicon?, codec? }
 *   (lib/types/types.d.ts:162-212).
 * - PickOutcome `{ text, continue? }` is the plain-text reference path: the
 *   pipeline replaces the active token span with literal text (types.d.ts
 *   :99-112) — exactly the FR-B6 requirement to insert a pure text token.
 * - The native ui-reference @source uses formatFileMention + trailing-slash
 *   directories for its mention strings (ui-reference/src/client/index.ts:99);
 *   our insertion format aligns with that grammar via formatMentionToken.
 *
 * Degradation (FR-B8): when the feature toggle is off (localStorage M2
 * placeholder until the Remote settings land in M5) or the inputTriggers
 * service is absent, registration is SKIPPED — never thrown.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only imports: the client bundle never loads host runtime modules here.
import type {
  ClientSessionContext,
  CandidateRequest,
  InputTriggerCandidate,
  InputTriggerServiceContract,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'

import { formatMentionToken } from './grammar.js'
import type { SearchFetcher } from './search.js'
import { createDebouncedSearch, makeHttpSearchFetcher } from './search.js'

/** localStorage key consulted per registration (M2 placeholder; M5 → Remote settings). */
export const MENTION_DISABLED_STORAGE_KEY = 'zdsh-filehub.mentionDisabled'

export function readMentionDisabled(storage?: Storage): boolean {
  if (typeof storage === 'undefined') return false
  try {
    return storage.getItem(MENTION_DISABLED_STORAGE_KEY) === '1'
  } catch {
    return false // storage denied → feature stays on, matching default-on UX
  }
}

interface ParsedCandidateValue {
  p: string
  k: 'file' | 'directory'
}

function candidateToEntry(
  entry: { relativePath: string; kind: 'file' | 'directory' },
  quoted: boolean,
): InputTriggerCandidate | undefined {
  const mention = formatMentionToken(entry.relativePath, entry.kind, quoted)
  if (mention === undefined) return undefined
  const value: ParsedCandidateValue = { p: entry.relativePath, k: entry.kind }
  const slash = entry.relativePath.lastIndexOf('/')
  const base = slash >= 0 ? entry.relativePath.slice(slash + 1) : entry.relativePath
  const parent = slash > 0 ? entry.relativePath.slice(0, slash) : undefined
  return {
    name: base,
    description: parent ?? entry.kind,
    section: 'filehub',
    value: JSON.stringify(value),
  }
}

export interface FileHubTriggerDeps {
  /** Search transport override (tests). */
  readonly fetchSearch?: SearchFetcher | undefined
  /** Session id resolver override (tests); defaults to the mounted-slot seam. */
  readonly sessionId?: (() => string | null) | undefined
  /** Storage override for the disabled flag (tests). */
  readonly storage?: Storage | undefined
}

/**
 * Build the FileHub `@` trigger source. Candidates come from the plugin's own
 * search endpoint (debounced), refined locally; picks insert plain text
 * aligned with the host grammar plus one trailing space.
 */
export function buildFileHubTriggerSource(deps: FileHubTriggerDeps = {}): InputTriggerSource {
  const resolveId = deps.sessionId ?? fallbackSessionId
  const fetchPage = createDebouncedSearch(
    deps.fetchSearch ?? makeHttpSearchFetcher(),
    resolveId,
    120,
  )
  let lastQuery = ''
  return {
    trigger: '@',
    name: 'filehub',
    order: 20,
    showGroupTitle: true,
    async candidates(_session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]> {
      lastQuery = req.query
      try {
        // Prefer the explicit session projection; fall back to the seam used
        // by the upload domain so both surfaces agree on "current session".
        const entries = await fetchPage(req.query, req.signal)
        return entries.flatMap(entry => candidateToEntry(entry, req.quoted === true) ?? [])
      } catch {
        return []
      }
    },
    onPick(pick) {
      let parsed: ParsedCandidateValue | undefined
      try {
        parsed = pick.candidate.value !== undefined ? (JSON.parse(pick.candidate.value) as ParsedCandidateValue) : undefined
      } catch {
        parsed = undefined
      }
      // Kind is matched against plain strings so hostile payloads cannot
      // smuggle a value outside the file/directory vocabulary.
      const kind: string | undefined = parsed?.k
      if (parsed === undefined || (kind !== 'file' && kind !== 'directory')) {
        return undefined
      }
      const quote = lastQuery.endsWith('"')
      const mention = formatMentionToken(
        parsed.p,
        kind,
        pick.candidate.name.includes(' ') || quote,
      )
      if (mention === undefined) return undefined
      // Plain-text reference path (host replaces the token span with this).
      // Trailing space terminates the token; no `continue` — our candidates
      // already include nested paths, so the menu closes after the insert.
      return { text: `${mention} ` }
    },
  }
}

let currentSessionSeam: string | null = null

/** Last session id reported by a mounted FileHub surface (mirrors upload/entries.tsx). */
export function setMentionSessionSeam(sessionId: string | null): void {
  currentSessionSeam = sessionId !== null && sessionId !== '' ? sessionId : null
}

function fallbackSessionId(): string | null {
  return currentSessionSeam
}

/**
 * Register the source with full degradation guards. Returns a disposer, or
 * undefined when registration was skipped (disabled flag / missing service).
 */
export function registerMentionTrigger(ctx: ClientContext, deps: FileHubTriggerDeps = {}): (() => void) | undefined {
  if (readMentionDisabled(deps.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage))) {
    ctx.logger.info('[filehub] mention trigger disabled by settings; skipping source registration')
    return undefined
  }
  let triggers: InputTriggerServiceContract | undefined
  try {
    triggers = (ctx as unknown as { get(name: string): unknown }).get('inputTriggers') as InputTriggerServiceContract | undefined
  } catch {
    triggers = undefined
  }
  if (!triggers || typeof triggers.registerSource !== 'function') {
    ctx.logger.warn('[filehub] inputTriggers service unavailable; @ picker not registered')
    return undefined
  }
  return triggers.registerSource(buildFileHubTriggerSource(deps))
}
