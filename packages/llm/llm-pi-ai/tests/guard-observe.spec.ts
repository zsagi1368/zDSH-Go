/**
 * T3 L5-A wire-body guard observation (observe-only) — interpreter, wrapper,
 * and adapter-injection specs per D1P2-whitelist-design v3 §4/§6/§7/§11.2.
 * The classifier eats opaque hash strings (it compares, never re-hashes), so
 * the pure cases run on synthetic chains; the wrapper and adapter cases run
 * against a local provider stand-in.
 *
 * @module @deepseek-ai/dsh-llm-pi-ai/tests/guard-observe
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmGuardMessageKind, LlmGuardObserveCapture, LlmGuardObserveMeta } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import {
  buildGuardSegments,
  classifyGuardObserve,
  createGuardFetchWrapper,
  isMessagesCreateBody,
  recognizeErrorImageSplit,
  recognizeEffortSynth,
  stripCacheControl,
} from '../src/guard-observe.ts'
import type { GuardObserveChainRecord, GuardObserveChainView } from '../src/guard-observe.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

const hashState = { fail: false }
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    createHash: (algorithm: Parameters<typeof actual.createHash>[0]) => {
      if (hashState.fail) throw new Error('crypto unavailable')
      return actual.createHash(algorithm)
    },
  }
})

afterEach(async () => {
  hashState.fail = false
  await closeMockServers()
})

const h = (label: string): string => `hash(${label})`
const META: LlmGuardObserveMeta = { provider: 'p', api: 'anthropic-messages', modelId: 'm', bodyBytes: 10 }

function segmentsOf(hashes: string[], kinds: LlmGuardMessageKind[] = hashes.map(() => 'normal')): LlmGuardObserveCapture['segments'] {
  return {
    systemHash: h('system'),
    toolsHash: h('tools'),
    messagesHash: hashes.join('|'),
    messageHashes: hashes,
    messageKinds: kinds,
  }
}

function record(seq: number, hashes: string[], kinds?: LlmGuardMessageKind[], meta: LlmGuardObserveMeta = META): GuardObserveChainRecord {
  return { seq, segments: segmentsOf(hashes, kinds) as NonNullable<ReturnType<typeof segmentsOf>>, meta }
}

function capture(attemptSeq: number, hashes: string[], kinds?: LlmGuardMessageKind[], meta: LlmGuardObserveMeta = META): LlmGuardObserveCapture & { segments: NonNullable<LlmGuardObserveCapture['segments']> } {
  return { schemaVersion: 1, attemptSeq, wholeHash: h('whole'), segments: segmentsOf(hashes, kinds) as NonNullable<ReturnType<typeof segmentsOf>>, meta }
}

const NO_TRANSITIONS: GuardObserveChainView = { transitionMarkBetween: () => undefined }

/** Chain-compare dispatch used by the pure cases (no transitions, no gap, first request). */
function decide(
  prev: GuardObserveChainRecord | undefined,
  cap: Parameters<typeof classifyGuardObserve>[0]['capture'],
  currentSeq = 2,
  gap = false,
): ReturnType<typeof classifyGuardObserve> {
  return classifyGuardObserve({ prev, first: undefined, capture: cap, chain: NO_TRANSITIONS, currentSeq, gap })
}

describe('three-segment capture (E-0 strip, D1P2 §3/§2.2)', () => {
  it('cache_control stripping makes a breakpoint migration hash-stable', () => {
    const message = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    const withBreakpoint = { ...message, content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }
    const before = buildGuardSegments({ model: 'm', messages: [message, withBreakpoint] })
    const after = buildGuardSegments({ model: 'm', messages: [withBreakpoint, message] })
    // Both orders strip to the same two messages: the breakpoint's host block
    // migrating between rounds cannot move any per-message hash.
    expect(before.messageHashes).toEqual(after.messageHashes)
  })

  it('strips cache_control at any depth, including tools and system', () => {
    const value = stripCacheControl({ a: { cache_control: { type: 'ephemeral' }, b: [{ cache_control: 1, c: 2 }] } })
    expect(value).toEqual({ a: { b: [{ c: 2 }] } })
  })

  it('hashes segments over the stripped stable serialization', () => {
    const body = { model: 'm', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
    const segments = buildGuardSegments(body)
    expect(segments.messageHashes).toHaveLength(1)
    expect(segments.messageKinds).toEqual(['normal'])
    expect(segments.systemHash).not.toBe(segments.toolsHash)
  })
})

describe('wire-form recognizers (D1P2 §4.1-§4.3)', () => {
  it('recognizes the effort-synth system message (class2)', () => {
    expect(recognizeEffortSynth({ role: 'system', content: [], output_config: { effort: 'high' } })).toBe(true)
    expect(recognizeEffortSynth({ role: 'system', content: [], output_config: { effort: 'ultra' } })).toBe(false)
    expect(recognizeEffortSynth({ role: 'system', content: [{ type: 'text', text: 'x' }], output_config: { effort: 'high' } })).toBe(false)
  })

  it('recognizes the deferred system-update form (class1)', () => {
    expect(LlmPiAi.recognizeDeferredReorderSystem({ role: 'system', content: [{ type: 'text', text: 'x' }] })).toBe(true)
    expect(LlmPiAi.recognizeDeferredReorderSystem({ role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 't' } }] })).toBe(true)
    expect(LlmPiAi.recognizeDeferredReorderSystem({ role: 'system', content: [] })).toBe(false)
  })

  it('recognizes the error toolResult image split (class3)', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseID: 't1' },
        { type: 'text', text: 'Images from the error result of tool call t1 (tool):' },
        { type: 'image', source: {} },
      ],
    }
    expect(recognizeErrorImageSplit(message)).toBe(true)
    expect(recognizeErrorImageSplit({ ...message, content: message.content.slice(0, 2) })).toBe(false)
  })

  it('labels kinds per message and keeps class-2 in place', () => {
    const segments = buildGuardSegments({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', content: [], output_config: { effort: 'low' } },
      ],
    })
    expect(segments.messageKinds).toEqual(['normal', 'class2'])
    expect(segments.messageHashes).toHaveLength(2)
  })

  it('accepts a messages.create body and rejects other shapes', () => {
    expect(isMessagesCreateBody({ model: 'm', messages: [] })).toBe(true)
    expect(isMessagesCreateBody({ model: 'm' })).toBe(false)
    expect(isMessagesCreateBody('nope')).toBe(false)
  })
})

describe('classification dispatch (D1P2 §4.5, §4.1-§4.4)', () => {
  it('records the first request without a chain verdict (RECORD_ONLY)', () => {
    expect(classifyGuardObserve({ prev: undefined, first: undefined, capture: capture(1, [h('a')]), chain: NO_TRANSITIONS, currentSeq: 1, gap: false }))
      .toEqual({ classified: true })
  })

  it('passes a monotonic extension despite differing frozen segments (S5 placeholder wiring)', () => {
    const prev = record(1, [h('a'), h('b')])
    // The stored system/tools hashes differ — through the placeholder pair the
    // frozen checks pass vacuously and only messages are compared.
    const next = capture(1, [h('a'), h('b'), h('c')], undefined, { ...META })
    next.segments = { ...next.segments, systemHash: h('other-system'), toolsHash: h('other-tools') }
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision).toEqual({ classified: true, monotonic: 'ok', sharedPrefixCount: 2 })
  })

  it('labels a class-2 carrier and measures the stripped denominator', () => {
    const prev = record(1, [h('a')])
    const next = capture(1, [h('a'), h('s2'), h('b')], ['normal', 'class2', 'normal'])
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision.monotonic).toBe('ok')
    expect(decision.classId).toBe('class2-effort-synth')
    // Denominator = prev with class-2 stripped, so the shared prefix is the
    // full stripped prev chain.
    expect(decision.sharedPrefixCount).toBe(1)
  })

  it('explains a class-1 deferred reorder and measures the variant prefix', () => {
    const prev = record(1, [h('a'), h('s1')], ['normal', 'class1'])
    const next = capture(1, [h('a'), h('new'), h('s1')])
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision).toEqual({
      classified: true,
      classId: 'class1-deferred-reorder',
      monotonic: 'ok-after-classification',
      sharedPrefixCount: 1,
    })
  })

  it('stays unclassified when the migrating tail is not all class-1', () => {
    const prev = record(1, [h('a'), h('b')], ['normal', 'normal'])
    const next = capture(1, [h('a'), h('new'), h('b')])
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision.monotonic).toBe('unclassified')
    expect(decision.classified).toBe(false)
    expect(decision.sharedPrefixCount).toBe(1)
  })

  it('stays unclassified when the tail does not reappear as a subsequence', () => {
    const prev = record(1, [h('a'), h('s1')], ['normal', 'class1'])
    const next = capture(1, [h('a'), h('gone'), h('other')])
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision.monotonic).toBe('unclassified')
  })

  it('fails loud on a duplicate-content message colliding with a migration (S2 limitation)', () => {
    // The interposed new message carries the same content hash as an earlier
    // prev message — the full-prev membership test declares this unclassified
    // rather than risking a miss.
    const prev = record(1, [h('dup'), h('s1')], ['normal', 'class1'])
    const next = capture(1, [h('dup'), h('dup'), h('s1')])
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision.monotonic).toBe('unclassified')
  })

  it('reports an in-place rewrite as unclassified with the measured mismatch point', () => {
    const prev = record(1, [h('a'), h('b')])
    const next = capture(1, [h('a'), h('rewritten')])
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision).toEqual({ classified: false, monotonic: 'unclassified', sharedPrefixCount: 1 })
  })

  it('reports a shrink as unclassified (prefix relation measures honestly)', () => {
    const prev = record(1, [h('a'), h('b'), h('c')])
    const next = capture(1, [h('a')])
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision.monotonic).toBe('unclassified')
    expect(decision.sharedPrefixCount).toBe(1)
  })

  it('labels a class-3 carrier on a clean chain', () => {
    const prev = record(1, [h('a')])
    const next = capture(1, [h('a'), h('e')], ['normal', 'class3'])
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision.monotonic).toBe('ok')
    expect(decision.classId).toBe('class3-error-images')
  })
})

describe('transition guards (D1P2 §4.5 W-J, §8.5, §7.6 R2-1/R3-3)', () => {
  it('exempts a compaction-marked round and records the kind', () => {
    const prev = record(1, [h('a')])
    const next = capture(1, [h('totally'), h('rewritten')])
    const chain: GuardObserveChainView = { transitionMarkBetween: () => 'compaction' }
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain, currentSeq: 2, gap: false })
    // Not unclassified: transitions stay out of the WARN domain.
    expect(decision).toEqual({ classified: true, monotonic: 'ok-after-reset', transition: { kind: 'compaction' } })
    expect(decision.sharedPrefixCount).toBeUndefined()
  })

  it('exempts a tailMerge round via the cache/ledger mark', () => {
    const prev = record(1, [h('a')])
    const next = capture(1, [h('totally'), h('rewritten')])
    const chain: GuardObserveChainView = { transitionMarkBetween: () => 'reset-rewrite' }
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain, currentSeq: 2, gap: false })
    expect(decision.transition).toEqual({ kind: 'reset-rewrite' })
  })

  it('guards a route change on any meta triple component, api included', () => {
    const prev = record(1, [h('a')], undefined, META)
    const apiSwitch = capture(1, [h('totally'), h('rewritten')], undefined, { ...META, api: 'openai-completions' })
    const apiDecision = decide(prev, apiSwitch)
    expect(apiDecision.transition).toEqual({ kind: 'route-change' })
    const modelSwitch = capture(1, [h('totally'), h('rewritten')], undefined, { ...META, modelId: 'other' })
    const modelDecision = decide(prev, modelSwitch)
    expect(modelDecision.transition).toEqual({ kind: 'route-change' })
  })

  it('prefers the meta triple over log marks when both fire', () => {
    const prev = record(1, [h('a')])
    const next = capture(1, [h('totally')], undefined, { ...META, provider: 'other' })
    const chain: GuardObserveChainView = { transitionMarkBetween: () => 'compaction' }
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain, currentSeq: 2, gap: false })
    expect(decision.transition).toEqual({ kind: 'route-change' })
  })

  it('api roundtrip A→B→A: both flip rounds guard; the first stable record compares again (R3-3)', () => {
    const base = record(1, [h('a')], undefined, META)
    const toB = capture(1, [h('rewritten')], undefined, { ...META, api: 'B' })
    const decisionB = classifyGuardObserve({ prev: base, first: undefined, capture: toB, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decisionB.transition).toEqual({ kind: 'route-change' })
    const baseB: GuardObserveChainRecord = { seq: 2, segments: toB.segments, meta: toB.meta }
    const backToA = capture(1, [h('rewritten'), h('b')], undefined, META)
    const decisionReturn = decide(baseB, backToA, 3)
    // The return round's meta still differs from its prev (B → A): another
    // guard round, NOT a normal comparison (R3-3 wording, replayed).
    expect(decisionReturn.transition).toEqual({ kind: 'route-change' })
    const baseA: GuardObserveChainRecord = { seq: 3, segments: backToA.segments, meta: backToA.meta }
    const stable = capture(1, [h('rewritten'), h('b'), h('c')], undefined, META)
    const decisionStable = decide(baseA, stable, 4)
    // The first chained record after the return resumes regular comparison.
    expect(decisionStable).toMatchObject({ classified: true, monotonic: 'ok' })
    expect(decisionStable.sharedPrefixCount).toBe(2)
  })
})

describe('degraded gap and per-attempt semantics (D1P2 §6 S3, §7, §4.4)', () => {
  it('marks ok-gap when a degraded record crossed the chain base', () => {
    const prev = record(1, [h('a')])
    const next = capture(1, [h('a'), h('b')])
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 3, gap: true })
    expect(decision).toEqual({ classified: true, monotonic: 'ok', chainGap: true, sharedPrefixCount: 1 })
  })

  it('marks unclassified-gap when the crossing comparison also fails', () => {
    const prev = record(1, [h('a')])
    const next = capture(1, [h('x')])
    const decision = classifyGuardObserve({ prev, first: undefined, capture: next, chain: NO_TRANSITIONS, currentSeq: 3, gap: true })
    expect(decision.monotonic).toBe('unclassified')
    expect(decision.chainGap).toBe(true)
  })

  it('explains a strict-tools rebuild attempt as class-4 without chain fields', () => {
    const first = record(1, [h('m1'), h('m2')])
    const attempt2 = capture(2, [h('m1'), h('m2')])
    attempt2.segments = { ...attempt2.segments, toolsHash: h('tools-downgraded') }
    const decision = classifyGuardObserve({ prev: record(0, [h('old')]), first, capture: attempt2, chain: NO_TRANSITIONS, currentSeq: 2, gap: true })
    expect(decision).toEqual({ classified: true, classId: 'class4-strict-downgrade' })
    expect(decision.monotonic).toBeUndefined()
    expect(decision.chainGap).toBeUndefined()
    expect(decision.sharedPrefixCount).toBeUndefined()
  })

  it('keeps a diverging rebuild attempt unclassified', () => {
    const first = record(1, [h('m1'), h('m2')])
    const attempt2 = capture(2, [h('m1'), h('changed')], undefined, META)
    attempt2.segments = { ...attempt2.segments, toolsHash: h('tools-downgraded') }
    const decision = classifyGuardObserve({ prev: undefined, first, capture: attempt2, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision).toEqual({ classified: false, monotonic: 'unclassified' })
  })

  it('stays unclassified when attempt 1 left no comparable capture', () => {
    const attempt2 = capture(2, [h('m1')])
    const decision = classifyGuardObserve({ prev: record(0, [h('old')]), first: undefined, capture: attempt2, chain: NO_TRANSITIONS, currentSeq: 2, gap: false })
    expect(decision).toEqual({ classified: false, monotonic: 'unclassified' })
  })
})

describe('fetch wrapper (A1/A4/A7, D1P2 §2.1/§6)', () => {
  function stubFetch(respond: () => Response): { calls: { input: unknown; init: RequestInit | undefined }[] } {
    const calls: { input: unknown; init: RequestInit | undefined }[] = []
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      calls.push({ input, init })
      return Promise.resolve(respond())
    })
    return { calls }
  }
  const ok: () => Response = () => new Response('{}', { status: 200 })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('captures whole and segment hashes of an anthropic body and releases the original bytes', () => {
    const { calls } = stubFetch(ok)
    const sink = vi.fn()
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const wrapped = createGuardFetchWrapper({ model: { provider: 'p', api: 'anthropic-messages', id: 'm' }, sink })
    void wrapped('http://x', { body, method: 'POST' })
    expect(sink).toHaveBeenCalledTimes(1)
    const captureOnce = sink.mock.calls[0]?.[0] as LlmGuardObserveCapture
    expect(captureOnce.attemptSeq).toBe(1)
    expect(captureOnce.wholeHash).toBe(createHash('sha256').update(body, 'utf8').digest('hex'))
    expect(captureOnce.segments?.messageHashes).toHaveLength(1)
    expect(captureOnce.degraded).toBeUndefined()
    expect(captureOnce.meta).toEqual({ provider: 'p', api: 'anthropic-messages', modelId: 'm', bodyBytes: Buffer.byteLength(body, 'utf8') })
    // Pass-through invariant: the exact original string reaches the network.
    expect(calls[0]?.init?.body).toBe(body)
  })

  it('counts attempts per wrapper closure (per-attempt semantics)', () => {
    stubFetch(ok)
    const sink = vi.fn()
    const body = JSON.stringify({ model: 'm', messages: [] })
    // One logical request = one wrapper closure = one counter.
    const first = createGuardFetchWrapper({ model: { provider: 'p', api: 'anthropic-messages', id: 'm' }, sink })
    void first('http://x', { body })
    void first('http://x', { body })
    // The next logical request builds its own closure and restarts at 1.
    const second = createGuardFetchWrapper({ model: { provider: 'p', api: 'anthropic-messages', id: 'm' }, sink })
    void second('http://x', { body })
    expect(sink.mock.calls.map(call => (call[0] as LlmGuardObserveCapture).attemptSeq)).toEqual([1, 2, 1])
  })

  it('degrades a non-string body without a whole hash (A7-2)', () => {
    stubFetch(ok)
    const sink = vi.fn()
    const wrapped = createGuardFetchWrapper({ model: { provider: 'p', api: 'anthropic-messages', id: 'm' }, sink })
    const form = new FormData()
    void wrapped('http://x', { body: form })
    const captureOnce = sink.mock.calls[0]?.[0] as LlmGuardObserveCapture
    expect(captureOnce.degraded).toEqual({ reason: 'non-string-body' })
    expect(captureOnce.wholeHash).toBeUndefined()
    expect(captureOnce.segments).toBeUndefined()
  })

  it('keeps the whole hash on a parse failure (A7-1)', () => {
    stubFetch(ok)
    const sink = vi.fn()
    const wrapped = createGuardFetchWrapper({ model: { provider: 'p', api: 'anthropic-messages', id: 'm' }, sink })
    void wrapped('http://x', { body: '{"messages": nope' })
    const captureOnce = sink.mock.calls[0]?.[0] as LlmGuardObserveCapture
    expect(captureOnce.degraded).toEqual({ reason: 'parse-failed' })
    expect(captureOnce.wholeHash).toBeDefined()
    expect(captureOnce.segments).toBeUndefined()
  })

  it('falls back to whole-package records for a non-anthropic api (U3)', () => {
    stubFetch(ok)
    const sink = vi.fn()
    const wrapped = createGuardFetchWrapper({ model: { provider: 'p', api: 'openai-completions', id: 'm' }, sink })
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    void wrapped('http://x', { body })
    const captureOnce = sink.mock.calls[0]?.[0] as LlmGuardObserveCapture
    expect(captureOnce.wholeHash).toBeDefined()
    expect(captureOnce.segments).toBeUndefined()
    expect(captureOnce.degraded).toBeUndefined()
  })

  it('degrades with no hashes at all when hashing fails (A7-3)', () => {
    stubFetch(ok)
    hashState.fail = true
    const sink = vi.fn()
    const wrapped = createGuardFetchWrapper({ model: { provider: 'p', api: 'anthropic-messages', id: 'm' }, sink })
    void wrapped('http://x', { body: JSON.stringify({ model: 'm', messages: [] }) })
    const captureOnce = sink.mock.calls[0]?.[0] as LlmGuardObserveCapture
    expect(captureOnce.degraded).toEqual({ reason: 'hash-failed' })
    expect(captureOnce.wholeHash).toBeUndefined()
    expect(captureOnce.segments).toBeUndefined()
  })
})

describe('adapter injection (A1, D1P2 §2.1)', () => {
  function adapterOf(providers: Record<string, LlmPiAi.PiAiProviderProfile>, guardObserve: boolean): LlmPiAi.PiAiAdapter {
    return new LlmPiAi.PiAiAdapter({
      profiles: () => resolveProfiles(providers),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
      guardObserve: () => guardObserve,
    })
  }

  const anthropicProfile = (baseURL: string): Record<string, LlmPiAi.PiAiProviderProfile> => ({
    'anthropic-mock': {
      apiKeyEnv: 'PI_TEST_KEY',
      api: 'anthropic-messages',
      baseURL,
      models: [{ id: 'claude-mock', contextWindow: 200_000 }],
    },
  })

  it('wraps the request with an observation surface when switch and sink are both present', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const captures: LlmGuardObserveCapture[] = []
    const adapter = adapterOf(anthropicProfile(server.url), true)
    const stream = adapter.stream({
      provider: 'anthropic-mock',
      model: 'claude-mock',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'p', model: 'm' } })],
      onGuardObserve: capture => captures.push(capture),
    })
    for await (const chunk of stream) void chunk
    expect(captures).toHaveLength(1)
    expect(captures[0]?.attemptSeq).toBe(1)
    expect(captures[0]?.segments?.messageHashes.length).toBeGreaterThan(0)
    expect(captures[0]?.wholeHash).toBeDefined()
    // The provider parsed the released bytes and answered, so the passthrough
    // delivered a valid request; the byte-identity proof lives at the wrapper.
    expect(server.requests[0]).toMatchObject({ model: 'claude-mock' })
  })

  it('installs no wrapper without a sink even when the switch is on (pass-through invariant)', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const adapter = adapterOf(anthropicProfile(server.url), true)
    const stream = adapter.stream({
      provider: 'anthropic-mock',
      model: 'claude-mock',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'p', model: 'm' } })],
    })
    for await (const chunk of stream) void chunk
    expect(server.requests).toHaveLength(1)
  })

  it('stays byte-identical to the baseline when the switch is off (default)', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const captures: LlmGuardObserveCapture[] = []
    const adapter = adapterOf(anthropicProfile(server.url), false)
    const stream = adapter.stream({
      provider: 'anthropic-mock',
      model: 'claude-mock',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'p', model: 'm' } })],
      onGuardObserve: capture => captures.push(capture),
    })
    for await (const chunk of stream) void chunk
    expect(captures).toEqual([])
    expect(server.requests).toHaveLength(1)
  })

  it('reaches the plugin config surface (guardObserve defaults off)', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const captures: LlmGuardObserveCapture[] = []
    const ctx = new Context()
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: anthropicProfile(server.url) })
    try {
      const result = await assemble(ctx, {
        model: 'claude-mock',
        provider: 'anthropic-mock',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'p', model: 'm' } })],
        onGuardObserve: capture => captures.push(capture),
      })
      expect(result.finish.kind).toBe('stop')
      expect(captures).toEqual([])
    } finally {
      vi.unstubAllEnvs()
      await ctx.fiber.dispose()
    }
  })
})

describe('isolation hooks (D1P2 §5.3 ②)', () => {
  it('imports no C2 symbol into the observation module', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/guard-observe.ts'), 'utf8')
    const c2Symbols = 'DeltaResetSink|ResetLedger|registerResetEvent|accountResetCost'
      + '|serializeLedger|persistCacheLedger|createResetLedger'
    expect(source).not.toMatch(new RegExp(c2Symbols))
  })

  it('asserts installed pi-ai support for the fetch option (A6)', () => {
    expect(() => {
      LlmPiAi.assertGuardObserveSupport()
    }).not.toThrow()
  })
})
