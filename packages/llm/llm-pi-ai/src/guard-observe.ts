/**
 * Wire-body guard observation interpreter (T3 L5-A, observe-only) per
 * `D1P2-whitelist-design.md` v3: the fetch wrapper captures the exact wire
 * bytes of each attempt (hash-then-passthrough — the original body is never
 * rewritten), and the pure classifier labels each segmented record against the
 * four known-legal wire classes, the three transition guards, and the
 * monotonic chain (reusing {@link verifyMonotonic} with same-shape placeholder
 * inputs so the frozen-segment checks pass vacuously and only the messages
 * machinery runs).
 *
 * Semantics baseline: this layer eats wire bytes, never pre-wire Context; it
 * records, measures, and warns but decides nothing — no reset event, no
 * rejection, no retry (D1P2 §1.1). Everything here is inert unless the host
 * attaches a sink AND the llm-pi-ai `guardObserve` switch is on (default off).
 *
 * @module dsh-llm-pi-ai/guard-observe
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Api, FetchFunction, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  LlmGuardMessageKind,
  LlmGuardObserveCapture,
  LlmGuardObserveEvent,
  LlmGuardObserveMeta,
  LlmGuardObserveSegments,
  LlmGuardObserveTransitionKind,
} from '@deepseek-ai/dsh-llm'
import { stableStringify, verifyMonotonic } from './cache-guardian.ts'

/**
 * A6 (compile half): the fetch-field existence assertion. The wrapper only
 * works on a pi-ai whose stream options accept `fetch` (forwarded to the
 * provider HTTP client — `ProviderRequestOptions.fetch` in the installed
 * 1.3.0). If the field ever leaves that contract this line fails the build.
 */
type FetchOptionExists = 'fetch' extends keyof SimpleStreamOptions ? true : never
export const PI_AI_FETCH_OPTION_ASSERTION: FetchOptionExists = true

/** A6 (runtime half): minimum installed pi-ai the observation surface may run on. */
export const PI_AI_GUARD_OBSERVE_MIN_VERSION = '1.3.0'

let supportMemo: { ok: boolean; found?: string; detail?: string } | undefined

/**
 * A6: assert the installed pi-ai supports the observation wrapper — the
 * runtime half of the fetch-field existence assertion. The resolved package's
 * own `package.json` is read straight from disk (an fs read of the resolved
 * entry's package root, not a module resolution of the un-exported subpath).
 * Missing support is a fail-loud configuration error, never a silent zero-record
 * posture (D1P2 §11.2 ⑥). Memoized: one probe per process.
 * @throws LlmError `INVALID_CONFIG` naming the installed version when the
 * installed pi-ai is older than {@link PI_AI_GUARD_OBSERVE_MIN_VERSION} or its
 * version cannot be established.
 */
export function assertGuardObserveSupport(): void {
  if (supportMemo === undefined) supportMemo = probePiAiGuardSupport()
  if (supportMemo.ok) return
  throw new LlmError(
    `llm-pi-ai: guardObserve requires @earendil-works/pi-ai >= ${PI_AI_GUARD_OBSERVE_MIN_VERSION}`
    + ' (ProviderRequestOptions.fetch forwarding, D1P2 A6); installed version reads as'
    + ` ${supportMemo.found ?? 'unknown'}${supportMemo.detail === undefined ? '' : ` (${supportMemo.detail})`}`
    + ' — refusing to enable the observation surface',
    'INVALID_CONFIG',
  )
}

function probePiAiGuardSupport(): { ok: boolean; found?: string; detail?: string } {
  try {
    // Type-level twin assertion lives above; a downgrade that removes the
    // field also fails this module's compile, so only the version needs a
    // runtime check here. The manifest is located by walking the same ancestor
    // chain Node itself resolves `@earendil-works/pi-ai` along — the direct
    // dependency's own node_modules entry comes first, so a stale store copy
    // can never shadow it. A module-resolution call is not usable here: the
    // dependency publishes an import-only exports map, so `require.resolve`
    // would refuse the very package that works at runtime.
    const manifest = findPiAiManifest(dirname(fileURLToPath(import.meta.url)))
    const found = typeof manifest?.version === 'string' ? manifest.version : undefined
    // `?? undefined` folds match()'s null into the same not-a-version bucket.
    const tuple = found?.match(/^(\d+)\.(\d+)\.(\d+)/) ?? undefined
    if (manifest === undefined) {
      return { ok: false, detail: 'installed package manifest not found' }
    }
    if (tuple === undefined) {
      return { ok: false, ...(found === undefined ? {} : { found }), detail: 'unparseable version' }
    }
    const minimum = PI_AI_GUARD_OBSERVE_MIN_VERSION.split('.').map(Number)
    const installed = tuple.slice(1).map(Number)
    let ordering = 0
    for (let index = 0; index < Math.max(installed.length, minimum.length) && ordering === 0; index++) {
      ordering = (installed[index] ?? 0) - (minimum[index] ?? 0)
    }
    return { ok: ordering >= 0, ...(found === undefined ? {} : { found }) }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function findPiAiManifest(startDir: string): { version?: unknown } | undefined {
  let dir = startDir
  for (let depth = 0; depth < 16; depth++) {
    try {
      const manifestPath = join(dir, 'node_modules', '@earendil-works', 'pi-ai', 'package.json')
      if (existsSync(manifestPath)) {
        return JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
      }
    } catch {
      // An unreadable candidate is not a version fact; keep walking.
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** E-0 (D1P2 §3): deep-walk `cache_control` off the wire value — type-blind, so a new block type inherits the same stripping. */
export function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'cache_control') continue
    out[key] = stripCacheControl(item)
  }
  return out
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ANTHROPIC_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** Class-2 recognizer (D1P2 §4.2): empty-content system message carrying the managed effort. */
export function recognizeEffortSynth(message: unknown): boolean {
  if (!isRecord(message) || message.role !== 'system') return false
  if (!Array.isArray(message.content) || message.content.length !== 0) return false
  const outputConfig = message.output_config
  if (!isRecord(outputConfig)) return false
  const effort = outputConfig.effort
  return typeof effort === 'string' && ANTHROPIC_EFFORTS.has(effort)
}

const DEFERRED_SYSTEM_BLOCK_TYPES = new Set(['text', 'tool_removal', 'tool_addition'])

/** Class-1 form recognizer (D1P2 §4.1): non-empty system message whose blocks are all deferred-update shapes. */
export function recognizeDeferredReorderSystem(message: unknown): boolean {
  if (!isRecord(message) || message.role !== 'system' || !Array.isArray(message.content)) return false
  if (message.content.length === 0) return false
  return message.content.every(block => isRecord(block)
    && typeof block.type === 'string'
    && DEFERRED_SYSTEM_BLOCK_TYPES.has(block.type))
}

const ERROR_IMAGE_CAPTION_PREFIX = 'Images from the error result of tool call '

/** Class-3 recognizer (D1P2 §4.3): user message whose trailing blocks split error-result images behind a caption. */
export function recognizeErrorImageSplit(message: unknown): boolean {
  if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.content)) return false
  const blocks: unknown[] = message.content
  let lastToolResult = -1
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (isRecord(block) && block.type === 'tool_result') lastToolResult = index
  }
  if (lastToolResult === -1) return false
  const tail = blocks.slice(lastToolResult + 1)
  if (tail.length < 2) return false
  const caption = tail[0]
  return isRecord(caption) && caption.type === 'text' && typeof caption.text === 'string'
    && caption.text.startsWith(ERROR_IMAGE_CAPTION_PREFIX)
    && tail.slice(1).every(block => isRecord(block) && block.type === 'image')
}

/** Wire-form label of one observed message (class-2, then class-1/class-3 by shape; roles make them disjoint). */
export function recognizeMessageKind(message: unknown): LlmGuardMessageKind {
  if (isRecord(message) && message.role === 'system') {
    if (recognizeEffortSynth(message)) return 'class2'
    if (recognizeDeferredReorderSystem(message)) return 'class1'
    return 'normal'
  }
  if (recognizeErrorImageSplit(message)) return 'class3'
  return 'normal'
}

/**
 * Three-segment capture of one anthropic-messages wire body (D1P2 §2.2
 * `segments`): E-0 strip, then whole-segment and per-message hashes.
 * Hashing a hostile or oversized body throws — the wrapper turns that into an
 * A7-3 degraded capture; parsing happens in the wrapper so A7-1 keeps its
 * wholeHash.
 * @param params - the parsed request body (top-level request params).
 * @returns the three-segment capture.
 */
export function buildGuardSegments(params: Record<string, unknown>): LlmGuardObserveSegments {
  const system = stripCacheControl(params.system ?? null)
  const tools = stripCacheControl(params.tools ?? null)
  const messages = (Array.isArray(params.messages) ? params.messages : []).map(stripCacheControl)
  return {
    systemHash: sha256(stableStringify(system)),
    toolsHash: sha256(stableStringify(tools)),
    messagesHash: sha256(stableStringify(messages)),
    messageHashes: messages.map(message => sha256(stableStringify(message))),
    messageKinds: messages.map(recognizeMessageKind),
  }
}

/** A messages.create-shaped body: the only shape this surface three-segments. */
export function isMessagesCreateBody(params: unknown): params is Record<string, unknown> {
  return isRecord(params) && typeof params.model === 'string' && Array.isArray(params.messages)
}

/** The chain base the classifier compares against: the most recent segmented record. */
export interface GuardObserveChainRecord {
  /** Session seq the record's event was appended at. */
  seq: number
  segments: LlmGuardObserveSegments
  meta: LlmGuardObserveMeta
}

/**
 * Host-owned read face over the session log the classifier needs (D1P2 §4.5
 * `chain`): the transition-mark scan. The host implements it over
 * `session.snapshotEvents()` with the window lower bound, keeping this module
 * session-free and spec-testable.
 */
export interface GuardObserveChainView {
  /**
   * Known-legal rewrite marks in the `(fromSeqInclusive, toSeqExclusive)` event
   * window. `compaction` wins when both mark families appear (D1P2 §4.5).
   */
  transitionMarkBetween(fromSeqInclusive: number, toSeqExclusive: number): LlmGuardObserveTransitionKind | undefined
}

/** Classification fields contributed to the `cache/guard-observe` event. */
export type GuardObserveDecision = Pick<
  LlmGuardObserveEvent,
  'classified' | 'classId' | 'monotonic' | 'transition' | 'chainGap' | 'sharedPrefixCount'
>

/**
 * Same-shape placeholder pair for the zero-change reuse of
 * {@link verifyMonotonic} (D1P2 §1.2 invariant declaration): both sides carry
 * the same constant in `systemHash`/`toolsHash` so the frozen-segment
 * comparisons pass vacuously — the checks are bypassed, not satisfied — and
 * only the messages machinery actually compares.
 */
const GUARD_PLACEHOLDER_HASH = ''

/** Sentinel distinguishing a wrong-shape body from a corrupt-JSON body. */
class NotMessagesCreateBodyError extends Error {
  constructor() {
    super('wire body is not a messages.create request')
    this.name = 'NotMessagesCreateBodyError'
  }
}

function shapedGuard(segment: {
  messagesHash: string
  messageHashes: readonly string[]
}): { systemHash: string; toolsHash: string; messagesHash: string; messageHashes: readonly string[] } {
  return {
    systemHash: GUARD_PLACEHOLDER_HASH,
    toolsHash: GUARD_PLACEHOLDER_HASH,
    messagesHash: segment.messagesHash,
    messageHashes: segment.messageHashes,
  }
}

/**
 * Class-2 strip for comparison (D1P2 §4.2): drop effort-synth entries, keeping
 * hashes and kinds aligned. `messagesHash` rides along unchanged — it is part
 * of the GuardState shape {@link shapedGuard} builds but the messages-only
 * reuse of {@link verifyMonotonic} never reads it.
 */
function stripClass2(segments: LlmGuardObserveSegments): {
  messagesHash: string
  messageHashes: string[]
  messageKinds: LlmGuardMessageKind[]
} {
  const messageHashes: string[] = []
  const messageKinds: LlmGuardMessageKind[] = []
  for (let index = 0; index < segments.messageHashes.length; index++) {
    if (segments.messageKinds[index] === 'class2') continue
    messageHashes.push(segments.messageHashes[index] ?? '')
    messageKinds.push(segments.messageKinds[index] ?? 'normal')
  }
  return { messagesHash: segments.messagesHash, messageHashes, messageKinds }
}

function firstMismatch(prev: readonly string[], next: readonly string[]): number | undefined {
  const shared = Math.min(prev.length, next.length)
  for (let index = 0; index < shared; index++) {
    if (prev[index] !== next[index]) return index
  }
  return undefined
}

function findSubsequence(haystack: readonly string[], needle: readonly string[], from: number): number | undefined {
  if (needle.length === 0) return from
  outer: for (let start = from; start + needle.length <= haystack.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) continue outer
    }
    return start
  }
  return undefined
}

export type DeferredReorderResult = { verdict: 'ok'; sharedPrefixCount: number } | { verdict: 'fail' }

/**
 * Class-1 deferred-reorder classifier (D1P2 §4.1): everything prev carries
 * from the first mismatch must be class-1-form system messages, and that block
 * must reappear in order as a subsequence after the mismatch point with only
 * new messages interleaved. The interposed-membership test runs against all of
 * prev (the declared S2 limitation: duplicate-content messages can turn a
 * legal migration into fail-loud noise rather than a miss).
 */
export function classifyDeferredReorder(
  prevHashes: readonly string[],
  prevKinds: readonly LlmGuardMessageKind[],
  nextHashes: readonly string[],
): DeferredReorderResult {
  const mismatch = firstMismatch(prevHashes, nextHashes)
  // No mismatch means one side is the other's prefix: a shrink (already
  // failed verifyMonotonic) or a full match (already passed) — a migration
  // explains neither.
  if (mismatch === undefined) return { verdict: 'fail' }
  const tail = prevHashes.slice(mismatch)
  if (tail.some((_, offset) => prevKinds[mismatch + offset] !== 'class1')) return { verdict: 'fail' }
  const position = findSubsequence(nextHashes, tail, mismatch)
  if (position === undefined) return { verdict: 'fail' }
  const interposed = nextHashes.slice(mismatch, position)
  if (interposed.some(hash => prevHashes.includes(hash))) return { verdict: 'fail' }
  // Prefix-retention measurement, class-1 variant (D1P2 §4.1 / §2.2): the
  // common prefix of prev minus its migrating tail against next.
  const strippedPrev = prevHashes.slice(0, mismatch)
  const shared = firstMismatch(strippedPrev, nextHashes)
  const sharedPrefixCount = shared ?? Math.min(strippedPrev.length, nextHashes.length)
  return { verdict: 'ok', sharedPrefixCount }
}

export type AttemptEqualityVerdict = 'chain-compare' | 'class4' | 'unclassified'

/**
 * Class-4 attempt signature (D1P2 §4.4): within one logical request, a
 * rebuild attempt is legal exactly when system and messages are byte-equal to
 * attempt 1 and only tools differ. Takes raw (unstripped) segment hashes.
 */
export function classifyAttemptEquality(
  first: { systemHash: string; toolsHash: string; messageHashes: readonly string[] } | undefined,
  attempt: { systemHash: string; toolsHash: string; messageHashes: readonly string[] },
): Exclude<AttemptEqualityVerdict, 'chain-compare'> {
  if (first === undefined) return 'unclassified'
  const sameSystem = first.systemHash === attempt.systemHash
  const sameMessages = first.messageHashes.length === attempt.messageHashes.length
    && first.messageHashes.every((hash, index) => hash === attempt.messageHashes[index])
  const toolsChanged = first.toolsHash !== attempt.toolsHash
  return sameSystem && sameMessages && toolsChanged ? 'class4' : 'unclassified'
}

function hasKind(segments: LlmGuardObserveSegments, kind: LlmGuardMessageKind): boolean {
  return segments.messageKinds.includes(kind)
}

function gapFields(gap: boolean): Pick<GuardObserveDecision, 'chainGap'> {
  return gap ? { chainGap: true } : {}
}

/**
 * messages-segment classification dispatch (D1P2 §4.5, W-G glue): class-4
 * first (in-request; no transitions inside a request), then the transition
 * guard before any comparison, then the monotonic chain on class-2-stripped
 * hashes with the class-1 fallback, else unclassified.
 * @param args.prev - chain base: the most recent segmented record; `undefined`
 * makes this a RECORD_ONLY first request.
 * @param args.first - attempt-1 record of the current logical request, for the
 * class-4 signature; `undefined` with attemptSeq > 1 means attempt 1 left no
 * comparable capture (degraded) and the attempt stays unclassified.
 * @param args.capture - the current capture; callers only dispatch here with
 * `segments` present.
 * @param args.chain - host transition-mark scan.
 * @param args.currentSeq - the seq this record's event will occupy (the
 * session seq before the append); bounds the transition scan window.
 * @param args.gap - whether a non-chain participant (degraded or whole-package
 * fallback record) sits between the chain base and now.
 * @returns the classification fields for the event.
 */
export function classifyGuardObserve(args: {
  prev: GuardObserveChainRecord | undefined
  first: Pick<GuardObserveChainRecord, 'segments' | 'meta'> | undefined
  capture: LlmGuardObserveCapture & { segments: LlmGuardObserveSegments }
  chain: GuardObserveChainView
  currentSeq: number
  gap: boolean
}): GuardObserveDecision {
  const { prev, first, capture, chain, currentSeq, gap } = args
  const segments = capture.segments
  if (capture.attemptSeq > 1) {
    // No chain compare on rebuild attempts, so no chainGap/sharedPrefixCount.
    if (classifyAttemptEquality(first?.segments, segments) === 'class4') {
      return { classified: true, classId: 'class4-strict-downgrade' }
    }
    return { classified: false, monotonic: 'unclassified' }
  }
  if (prev === undefined) {
    // RECORD_ONLY (first request / first record after resume): the chain
    // starts here. Form labels still annotate the record.
    if (hasKind(segments, 'class3')) return { classified: true, classId: 'class3-error-images' }
    return { classified: true }
  }
  // Transition guard (W-J) before any comparison: meta triple mismatch is a
  // route change (aligned with transformMessages' isSameModel = provider∧api∧model,
  // D1P2 §7.6); log marks make compaction/reset rewrites.
  const byRoute: LlmGuardObserveTransitionKind | undefined =
    prev.meta.provider !== capture.meta.provider
      || prev.meta.api !== capture.meta.api
      || prev.meta.modelId !== capture.meta.modelId
      ? 'route-change'
      : undefined
  const transition = byRoute ?? chain.transitionMarkBetween(prev.seq + 1, currentSeq)
  if (transition !== undefined) {
    // Bytes are still recorded (segments ride the capture); no shared-prefix
    // measurement across a rewrite, and no WARN (D1P2 §8.5).
    return { classified: true, monotonic: 'ok-after-reset', transition: { kind: transition } }
  }
  const prevCore = stripClass2(prev.segments)
  const nextCore = stripClass2(segments)
  if (verifyMonotonic(shapedGuard(prevCore), shapedGuard(nextCore)).ok) {
    // Full prefix match on the stripped chain. A class-2-labeled record says
    // the strip participated; class-3 form rides messageKinds.
    const classId = hasKind(segments, 'class2')
      ? 'class2-effort-synth'
      : hasKind(segments, 'class3') ? 'class3-error-images' : undefined
    return {
      classified: true,
      ...classId === undefined ? {} : { classId },
      monotonic: 'ok',
      ...gapFields(gap),
      sharedPrefixCount: prevCore.messageHashes.length,
    }
  }
  const reorder = classifyDeferredReorder(prevCore.messageHashes, prevCore.messageKinds, nextCore.messageHashes)
  if (reorder.verdict === 'ok') {
    return {
      classified: true,
      classId: 'class1-deferred-reorder',
      monotonic: 'ok-after-classification',
      ...gapFields(gap),
      sharedPrefixCount: reorder.sharedPrefixCount,
    }
  }
  const mismatch = firstMismatch(prevCore.messageHashes, nextCore.messageHashes)
  return {
    classified: false,
    monotonic: 'unclassified',
    ...gapFields(gap),
    sharedPrefixCount: mismatch ?? Math.min(prevCore.messageHashes.length, nextCore.messageHashes.length),
  }
}

/** The wrapper-closure capture of one logical request (A1/A4: built per stream call, one attemptSeq counter). */
export interface GuardFetchWrapperArgs {
  model: Pick<Model<Api>, 'provider' | 'api' | 'id'>
  sink: (capture: LlmGuardObserveCapture) => void
}

/**
 * Build the hash-then-passthrough fetch wrapper for one logical request
 * (D1P2 §2.1: the factory runs per `streamSimple` call, so the closure's
 * attempt counter is the per-attempt semantics with zero grouping heuristics).
 * Every path calls the sink synchronously at fetch time and then releases the
 * untouched original call to `globalThis.fetch` — the wrapper never rewrites
 * `init.body`.
 *
 * Capture ladder (D1P2 §6): non-string body → A7-2 (no wholeHash); hash
 * failure → A7-3 (wholeHash and segments both absent); parse failure → A7-1
 * (wholeHash kept, segments absent); non-anthropic or non-`messages.create`
 * body → whole-package fallback only (U3: no three-segmentation); otherwise
 * full segments.
 * @param args - the request's resolved model and the host sink.
 * @returns the `fetch` implementation to pass in the stream options.
 */
export function createGuardFetchWrapper(args: GuardFetchWrapperArgs): FetchFunction {
  let attemptSeq = 0
  return (input, init) => {
    const attempt = ++attemptSeq
    const meta: LlmGuardObserveMeta = {
      provider: args.model.provider,
      api: args.model.api,
      modelId: args.model.id,
      bodyBytes: 0,
    }
    const release = (): Promise<Response> => globalThis.fetch(input, init)
    const body = init?.body
    if (typeof body !== 'string') {
      args.sink({ schemaVersion: 1, attemptSeq: attempt, degraded: { reason: 'non-string-body' }, meta })
      return release()
    }
    meta.bodyBytes = Buffer.byteLength(body, 'utf8')
    let wholeHash: string
    try {
      wholeHash = sha256(body)
    } catch {
      args.sink({ schemaVersion: 1, attemptSeq: attempt, degraded: { reason: 'hash-failed' }, meta })
      return release()
    }
    if (args.model.api !== 'anthropic-messages') {
      // 非 anthropic API 三段化不做（U3）：整包单段哈希兜底记录。
      args.sink({ schemaVersion: 1, attemptSeq: attempt, wholeHash, meta })
      return release()
    }
    let params: unknown
    try {
      params = JSON.parse(body)
      if (!isMessagesCreateBody(params)) throw new NotMessagesCreateBodyError()
    } catch (error) {
      const parseFailed = error instanceof SyntaxError || error instanceof NotMessagesCreateBodyError
      // A7-1 keeps the whole hash; a non-messages.create body is recorded the
      // same way (parsed fine, nothing to three-segment). Any other throw —
      // JSON.parse does not throw others today, but a future serializer could —
      // degrades as a hash failure with the whole hash withheld.
      args.sink({
        schemaVersion: 1,
        attemptSeq: attempt,
        ...parseFailed ? { wholeHash } : {},
        meta,
        degraded: { reason: parseFailed ? 'parse-failed' : 'hash-failed' },
      })
      return release()
    }
    let segments: LlmGuardObserveSegments
    try {
      segments = buildGuardSegments(params)
    } catch {
      // A7-3: any hashing failure withholds the whole hash too (D1P2 §6 table).
      args.sink({ schemaVersion: 1, attemptSeq: attempt, degraded: { reason: 'hash-failed' }, meta })
      return release()
    }
    args.sink({ schemaVersion: 1, attemptSeq: attempt, wholeHash, segments, meta })
    return release()
  }
}
