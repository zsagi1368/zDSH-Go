/**
 * Mention pipeline (P01 §6-B): send-time existence validation + structured
 * injection over the host agent message waterfall, plus the candidate search
 * endpoint backing the composer `@` picker.
 *
 * Host facts this encodes (verified against the shipped Fork):
 * - `agent/pre-step` is a WATERFALL on the cordis context: payload
 *   `{ agent, messages: UserMessage[], turn, step, signal }`, listener shape
 *   `(payload, next) => Promise<PreStepDecision>` where PreStepDecision is
 *   `{ kind: 'reject' } | { kind: 'enter', messages }`
 *   (packages/core/agent-loop/src/agent.ts:235-241 dispatch;
 *    packages/core/agent/src/runtime-types.ts:231 listener type).
 * - Production listeners wrap `next()` and rewrite the enter branch — the
 *   exact pattern used here (packages/context/session-reference/src/index.ts:106-113,
 *   including `{ prepend: true }` when early ordering matters; we register in
 *   natural order and transform AFTER next() so downstream listeners observe
 *   the original claimed batch).
 * - User messages carry `source.kind === 'user'` and text blocks
 *   `{ type: 'text', text }` (packages/context/session-reference/src/index.ts:130-136;
 *    packages/llm/llm/src/message.ts:96-143). Messages are frozen snapshots,
 *   so any modification must clone first.
 * - Token grammar alignment: word-initial `@` per activeAtToken
 *   `(?:^|\s)(@([^\s]*))$` plus the `@"quoted"` form for paths containing
 *   whitespace (packages/context/file-reference/src/grammar.ts:26-55). The
 *   scanner below is a hand-rolled equivalent so the server stays free of a
 *   browser-package dependency; mirrored unit tests pin both sides.
 *
 * Content boundary (FR-B5 hard rule): file CONTENT never crosses the wire.
 * Injection appends only `<workspace-reference path kind />` tags that match
 * WorkspaceReferenceSchema (src/contract.ts) — path + kind, nothing else.
 */

import fsPromises from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'

import { SearchResultSchema, WorkspaceReferenceSchema } from '../contract.js'
export { SearchResultSchema } from '../contract.js'
import type { FileEntry } from '../contract.js'
import { sendError, sendJson } from './httpUtil.js'
import type { HttpHandler } from './upload.js'
import type { MetaStore } from './meta.js'
import {
  rankWorkspaceCandidates,
} from './workspace.js'
import type { WorkspaceIndexer } from './workspace.js'
import type { SessionsLike, WorkspaceResolver } from './workspace.js'

// ---------------------------------------------------------------------------
// Token grammar (server-side scan of user draft text)
// ---------------------------------------------------------------------------

/** One scanned @token occurrence inside a piece of draft text. */
export interface MentionToken {
  /** Raw text as typed, e.g. `@"docs/my notes.md"`. */
  readonly raw: string
  /** The path value after `@` (quotes stripped for the quoted form). */
  readonly value: string
  readonly quoted: boolean
  /** Half-open [start, end) span of raw within the scanned text. */
  readonly start: number
  readonly end: number
}

function isWhitespace(char: string | undefined): boolean {
  if (char === undefined) return false
  return /\s/u.test(char)
}

/**
 * Scan draft text for word-initial @tokens (plain `@path` and quoted
 * `@"path with spaces"`), aligned with the host grammar. An `@` glued to the
 * previous word (email addresses like `a@b.com`) never triggers.
 */
export function scanMentionTokens(text: string): MentionToken[] {
  const tokens: MentionToken[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    // Word-initial rule aligned with host activeAtToken `(?:^|\s)@`.
    const atWordBoundary = index === 0 || isWhitespace(text[index - 1])
    if (char !== '@' || !atWordBoundary) {
      index += 1
      continue
    }
    const next = text[index + 1]
    if (next === '"') {
      const close = text.indexOf('"', index + 2)
      if (close > index + 2) {
        const value = text.slice(index + 2, close)
        tokens.push({ raw: text.slice(index, close + 1), value, quoted: true, start: index, end: close + 1 })
        index = close + 1
        continue
      }
      // Unterminated quote: treat the rest as a plain token query, not a token.
      break
    }
    let cursor = index + 1
    while (cursor < text.length && !isWhitespace(text[cursor])) cursor += 1
    if (cursor > index + 1) {
      const value = text.slice(index + 1, cursor)
      tokens.push({ raw: text.slice(index, cursor), value, quoted: false, start: index, end: cursor })
    }
    index = cursor
  }
  return tokens
}

/** Escape an attribute value for embedding in the reference tag. */
function escapeAttribute(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

// ---------------------------------------------------------------------------
// Existence validation (FR-B3 semantics)
// ---------------------------------------------------------------------------

export type MentionValidation =
  | { readonly status: 'ok'; readonly path: string; readonly kind: 'file' | 'directory'; readonly absolutePath: string }
  | { readonly status: 'invalid'; readonly reason: 'absolute' | 'escapes-workspace' | 'not-found' }

/**
 * Validate one @token value against a workspace cwd:
 * - absolute paths are rejected outright;
 * - after resolve(), a relative path containing `..` (i.e. escaping the cwd)
 *   is rejected;
 * - stat decides file vs directory; anything else is not-found.
 */
export async function validateMentionToken(value: string, cwd: string): Promise<MentionValidation> {
  const trimmed = value.trim()
  if (trimmed === '') return { status: 'invalid', reason: 'absolute' }
  // Windows drive letters / UNC and POSIX roots all count as absolute here.
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/u.test(trimmed) || path.isAbsolute(trimmed)) {
    return { status: 'invalid', reason: 'absolute' }
  }
  const base = path.resolve(cwd)
  const absolutePath = path.resolve(base, trimmed)
  const relative = path.relative(base, absolutePath)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    relative.startsWith('..\\') ||
    relative.startsWith('../') ||
    path.isAbsolute(relative)
  ) {
    return { status: 'invalid', reason: 'escapes-workspace' }
  }
  let stats: Stats
  try {
    stats = await fsPromises.stat(absolutePath)
  } catch {
    return { status: 'invalid', reason: 'not-found' }
  }
  if (stats.isFile()) {
    // Reference paths are workspace-relative with forward slashes on every OS.
    return { status: 'ok', path: relative.replace(/\\/gu, '/'), kind: 'file', absolutePath }
  }
  if (stats.isDirectory()) {
    return { status: 'ok', path: relative.replace(/\\/gu, '/'), kind: 'directory', absolutePath }
  }
  return { status: 'invalid', reason: 'not-found' }
}

/**
 * Render validated references as schema-matching tags, one per line. Only
 * path + kind are embedded — never content (FR-B5).
 */
export function renderReferenceTags(references: ReadonlyArray<{ path: string; kind: 'file' | 'directory' }>): string {
  return references
    .map((reference) => {
      const parsed = WorkspaceReferenceSchema.parse(reference)
      return `<workspace-reference path="${escapeAttribute(parsed.path)}" kind="${parsed.kind}" />`
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Structural seams over the pre-step surface (kept free of host type imports)
// ---------------------------------------------------------------------------

/** Structural view of the host registration face for context events. */
export interface HostEventsLike {
  on(
    event: string,
    listener: (...args: unknown[]) => unknown,
    options?: { readonly prepend?: boolean },
  ): () => void
}

/** Structural subset of the host Agent this pipeline reads (cwd only). */
export interface MentionAgentLike {
  session?: { header?: { cwd?: string } } | undefined
}

interface TextBlockLike {
  readonly type: string
  readonly text?: unknown
}

interface UserMessageLike {
  readonly id: unknown
  readonly role: string
  readonly source?: { readonly kind?: string } | undefined
  readonly content: readonly TextBlockLike[]
}

type MutableMessage = {
  -readonly [K in keyof UserMessageLike]: UserMessageLike[K]
}

/** Local deep freeze — mirrors dsh-llm freezeMessage without importing it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

export interface MentionInjectorDeps {
  logWarn: (message: string) => void
}

export interface MentionInjector {
  /**
   * Register the `agent/pre-step` listener. Returns the disposer. Absent
   * events service → attach throws? No: callers guard; this function expects
   * a live events face.
   */
  attach(events: HostEventsLike): () => void
}

/**
 * Build the send-time injector: validates @tokens in user messages entering a
 * step and appends one structured-reference block per message.
 *
 * Invalid-token policy (spec offers marker-in-message OR warn log — we chose
 * the WARN LOG): appending invalid markers into model-visible text would hand
 * the model paths we know do not exist, inviting confusion or hallucinated
 * reads; a warn keeps the transcript clean while staying debuggable.
 */
export function createMentionInjector(deps: MentionInjectorDeps): MentionInjector {
  const injectReferences = async (
    messages: readonly unknown[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<unknown[]> =>
    Promise.all(
      messages.map(async (message) => {
        const candidate = message as UserMessageLike
        if (candidate.source?.kind !== 'user' || candidate.role !== 'user' || !Array.isArray(candidate.content)) {
          return message
        }
        const tokens = candidate.content.flatMap((block: TextBlockLike | undefined) =>
          block?.type === 'text' && typeof block.text === 'string' ? scanMentionTokens(block.text) : [],
        )
        if (tokens.length === 0) return message

        // Validate unique values in order of first appearance.
        const seen = new Set<string>()
        const orderedValues: string[] = []
        for (const token of tokens) {
          if (seen.has(token.value)) continue
          seen.add(token.value)
          orderedValues.push(token.value)
        }
        const validations = await Promise.all(orderedValues.map(value => validateMentionToken(value, cwd)))
        if (signal.aborted) return message

        const valid = validations.filter((entry): entry is Extract<MentionValidation, { status: 'ok' }> => entry.status === 'ok')
        const invalid = validations.filter(entry => entry.status !== 'ok')
        if (valid.length === 0) {
          if (invalid.length > 0) {
            deps.logWarn(
              `[filehub] mentions ignored (unresolvable in workspace): ${orderedValues.join(', ')}`,
            )
          }
          return message
        }
        if (invalid.length > 0) {
          const offenders = orderedValues.filter((_, index) => validations[index]?.status !== 'ok')
          deps.logWarn(`[filehub] mentions ignored (unresolvable in workspace): ${offenders.join(', ')}`)
        }

        const tags = renderReferenceTags(valid)
        const mutable = structuredClone(candidate) as MutableMessage & { content: Array<TextBlockLike> }
        mutable.content = [...mutable.content, { type: 'text', text: tags }]
        return deepFreeze(mutable)
      }),
    )

  return {
    attach(events: HostEventsLike): () => void {
      return events.on(
        'agent/pre-step',
        async (payload: unknown, next: unknown): Promise<unknown> => {
          const { agent, signal } = payload as { agent?: MentionAgentLike; signal?: AbortSignal }
          type StepDecision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }
          const nextFn = next as () => Promise<{ kind: string; messages?: unknown[] }> | { kind: string; messages?: unknown[] }
          const decision = (await nextFn()) as StepDecision
          if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
          const cwd = agent?.session?.header?.cwd
          if (typeof cwd !== 'string' || cwd === '' || signal?.aborted === true) return decision
          const messages = await injectReferences(decision.messages, cwd, signal ?? new AbortController().signal)
          return { kind: 'enter', messages }
        },
      )
    },
  }
}

// ---------------------------------------------------------------------------
// Search endpoint: GET /api/filehub/search?sessionId=&q=
// ---------------------------------------------------------------------------

/**
 * The wire schema (SearchResultSchema) lives in src/contract.ts since M6 —
 * the old TODO(M5 consolidation) seam is closed: contract.ts is the single
 * wire-shape source and this module re-exports it for compatibility.
 */

export interface SearchServiceDeps {
  indexer: WorkspaceIndexer
  meta: MetaStore
  workspaces: WorkspaceResolver
  sessions?: SessionsLike | undefined
  /** Response page cap. Default 50. */
  limit?: number | undefined
}

/** Absolute path from a cwd-relative forward-slash path (Windows-safe). */
function absoluteOf(cwd: string, relativePath: string): string {
  return path.join(cwd, ...relativePath.split('/'))
}

const UPLOAD_DIR_PREFIX = '.filehub/'

/**
 * Double-source merge (workspace index ∪ this session's uploads) + basename
 * scoring, capped at `limit` entries with a truncated flag.
 */
export function mergeSearchEntries(
  cwd: string,
  index: { readonly entries: readonly { readonly relativePath: string; readonly kind: 'file' | 'directory' }[] },
  uploads: Record<string, { sizeBytes: number; uploadedAtMs: number }>,
): FileEntry[] {
  const byRelative = new Map<string, FileEntry>()
  for (const candidate of index.entries) {
    byRelative.set(candidate.relativePath, {
      path: absoluteOf(cwd, candidate.relativePath),
      relativePath: candidate.relativePath,
      sizeBytes: 0, // walk does not stat every node; sizes come from upload meta
      kind: candidate.kind,
    })
  }
  // Upload rows live under <cwd>/.filehub/<key>; keys are storage-root
  // relative (see list.ts), so their workspace-relative path gains the prefix.
  for (const [key, row] of Object.entries(uploads)) {
    const relativePath = `${UPLOAD_DIR_PREFIX}${key}`
    byRelative.set(relativePath, {
      path: absoluteOf(cwd, relativePath),
      relativePath,
      sizeBytes: row.sizeBytes,
      kind: 'file',
      uploadedAtMs: row.uploadedAtMs,
    })
  }
  return [...byRelative.values()]
}

export function createSearchHandler(deps: SearchServiceDeps): HttpHandler {
  const limit = Math.max(1, deps.limit ?? 50)

  return async function handleSearch(req, res) {
    let sessionId: string | null = null
    let query = ''
    try {
      const url = new URL(req.url ?? '/', 'http://filehub.invalid')
      sessionId = url.searchParams.get('sessionId')
      query = url.searchParams.get('q') ?? ''
    } catch {
      sessionId = null
    }
    const workspace =
      sessionId !== null && sessionId !== '' ? deps.workspaces.resolve(sessionId) : undefined
    if (!workspace || sessionId === null) {
      sendError(res, 403, 'unknown session')
      return
    }

    const [index, record] = await Promise.all([
      deps.indexer.get(sessionId),
      deps.meta.get(sessionId).catch(() => ({ files: {} })),
    ])

    const merged = mergeSearchEntries(workspace.cwd, index ?? { entries: [] }, record.files)
    const ranked = rankWorkspaceCandidates(query.trim(), merged)
    const page = ranked.slice(0, limit)
    const result = SearchResultSchema.parse({
      sessionId: workspace.sessionId,
      entries: page.map(({ score: _score, ...entry }) => entry),
      truncated: ranked.length > page.length || (index?.truncated ?? false),
    })
    sendJson(res, 200, result)
  }
}
