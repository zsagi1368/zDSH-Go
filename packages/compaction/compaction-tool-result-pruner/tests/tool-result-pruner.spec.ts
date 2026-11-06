import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId , createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner, {
  codePointLength,
  DEFAULTS,
  PRUNE_MARKER,
  resolveConfig,
} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { ToolResultPruneConfig } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { PRUNING_META_KEY, toolCapToByteLimit } from '@deepseek-ai/dsh-tools'

const MODEL = 'test-model'
const SMALL: ToolResultPruneConfig = {
  thresholdChars: 50,
  headChars: 4,
  tailChars: 3,
}

function service(config: ToolResultPruneConfig = SMALL): ToolResultPruner {
  const ctx = new Context()
  // Service constructors self-register, so `ctx.tokenMeter` resolves for the
  // shadow-price pricing without a full plugin boot.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return new ToolResultPruner(ctx, config)
}

/** Pricing oracle mirroring the service's estimator for expectations. */
const METER_CTX = new Context()
new SessionProjectionRegistry(METER_CTX)
const METER = new TokenMeter(METER_CTX)

function appendToolStep(
  session: Session,
  turn: number,
  call: string,
  content: ContentBlock[],
  extra: Record<string, unknown> = {},
): number {
  const callId = ToolCallId(call)
  session.append('turn/start', {
    turn,
  })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: {
        kind: 'model',
        ...{ provider: MODEL, model: MODEL },
      },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: extra['error'] !== undefined }),
    ...extra,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

describe('tool-result pruning configuration', () => {
  it('preserves a logged image offload when pruning the same result later', () => {
    const session = Session.create(SessionId('prune-offloaded'), undefined, undefined, undefined, [imageOffloadProjection])
    const seq = appendToolStep(session, 1, 'shot', [
      { type: 'text', text: 'x'.repeat(200) },
      { type: 'image', attachment: {
        attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } },
    ])
    session.append('image/offload', { targets: [{ seq: SessionSeq(seq), imageIndexes: [0] }] })
    const pruned = service().pruneSession(session)
    expect(pruned.pruned).toHaveLength(1)
    const replacement = session.snapshotEvents().at(-1)!
    expect(replacement.type).toBe('tool/result')
    expect(JSON.stringify(session.deriveEventMessage(replacement))).toContain('"offloaded":true')
    expect(JSON.stringify(Session.create(SessionId('restored-offloaded'), session.snapshotEvents(), undefined, undefined, [imageOffloadProjection]).deriveMessages())).toContain('"offloaded":true')
    expect(JSON.stringify(session.eventAt(SessionSeq(seq)))).not.toContain('offloaded')
  })

  it('resolves detached immutable defaults and partial overrides', () => {
    const raw = { thresholdChars: 100, headChars: 20, tailChars: 10 }
    const resolved = resolveConfig(raw)
    raw.headChars = 1
    expect(resolved).toEqual({ thresholdChars: 100, headChars: 20, tailChars: 10 })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(DEFAULTS).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
  })

  it('rejects stale keys, invalid scalars, and an output budget above threshold', () => {
    const bad = [
      [{ thresholdChars: 0 }, /thresholdChars .* positive integer/],
      [{ headChars: -1 }, /headChars .* non-negative integer/],
      [{ tailChars: 1.5 }, /tailChars .* non-negative integer/],
      [{ thresholdChars: 50, headChars: 20, tailChars: 20 }, /headChars \+ marker \+ tailChars/],
      [{ threshold: 10 }, /unknown key "threshold"/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as ToolResultPruneConfig)).toThrow(pattern)
    }
  })
})

describe('ToolResultPruner content transform', () => {
  it('measures text code points only and skips content within threshold', () => {
    const prune = service()
    const blocks = [
      { type: 'text', text: 'a😀b' },
      { type: 'reasoning', text: 'not measured' },
    ] satisfies ContentBlock[]
    expect(prune.measureContent(blocks)).toBe(3)
    expect(prune.pruneContent(blocks)).toBeNull()
    expect(codePointLength('a😀b')).toBe(3)
  })

  it('keeps configured head and tail without splitting surrogate pairs', () => {
    const prune = service()
    const result = prune.pruneContent([{ type: 'text', text: '😀'.repeat(60) }])
    expect(result).toEqual([{
      type: 'text',
      text: `${'😀'.repeat(4)}${PRUNE_MARKER}${'😀'.repeat(3)}`,
    }])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(50)
    expect(result![0]).toMatchObject({ type: 'text' })
    expect((result![0] as { text: string }).text).not.toContain('\uFFFD')
  })

  it('preserves non-text blocks and their relative ordering across removed text', () => {
    const prune = service()
    const reasoning: ContentBlock = { type: 'reasoning', text: 'private-rich-block' }
    const call: ContentBlock = {
      type: 'tool-call',
      id: ToolCallId('nested'),
      name: 'nested',
      arguments: '{}',
    }
    const result = prune.pruneContent([
      { type: 'text', text: 'A'.repeat(40) },
      reasoning,
      { type: 'text', text: 'B'.repeat(30) },
      call,
      { type: 'text', text: 'C'.repeat(30) },
    ])
    expect(result).toEqual([
      { type: 'text', text: `AAAA${PRUNE_MARKER}` },
      reasoning,
      call,
      { type: 'text', text: 'CCC' },
    ])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(50)
  })

  it('supports zero-sized head and tail while still shrinking', () => {
    const prune = service({
      thresholdChars: codePointLength(PRUNE_MARKER),
      headChars: 0,
      tailChars: 0,
    })
    const result = prune.pruneContent([{ type: 'text', text: 'x'.repeat(100) }])
    expect(result).toEqual([{ type: 'text', text: PRUNE_MARKER }])
    expect(prune.measureContent(result!)).toBe(prune.config.thresholdChars)
  })
})

describe('ToolResultPruner session transaction', () => {
  it('prunes a stable snapshot, preserves all data, and cites the replaced result', () => {
    const session = Session.create(SessionId('preserve'))
    const originalSeq = appendToolStep(session, 1, 'one', [{
      type: 'text',
      text: 'x'.repeat(100),
    }], {
      isError: true,
      error: { name: 'ExitError', code: 'EXIT_1' },
      meta: { diff: ['a', 'b'] },
      futureField: { nested: true },
    })
    session.append('turn/start', {
      turn: 2,
    })

    const result = service().pruneSession(session)
    expect(result.pruned).toHaveLength(1)
    expect(result.charsRemoved).toBeGreaterThan(0)
    const entry = result.pruned[0]!
    expect(entry).toMatchObject({ originalSeq, callId: ToolCallId('one'), charsBefore: 100 })
    expect(entry.charsAfter).toBeLessThanOrEqual(50)

    const original = session.snapshotEvents()[originalSeq]!
    const replacement = session.snapshotEvents()[entry.replacementSeq]! as SurfaceEvent
    expect(original).toMatchObject({
      type: 'tool/result',
      data: {
        message: {
          content: [{ type: 'text', text: 'x'.repeat(100) }],
        },
      },
    })
    expect(replacement).toMatchObject({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        isError: true,
        message: {
          source: { kind: 'tool', callId: ToolCallId('one') },
          role: 'tool',
          toolCallId: ToolCallId('one'),
          isError: true,
        },
        error: { name: 'ExitError', code: 'EXIT_1' },
        meta: { diff: ['a', 'b'] },
        futureField: { nested: true },
      },
      surfaceOp: { op: 'replace', startSeq: originalSeq, endSeq: originalSeq },
      sourceEventSeqs: [originalSeq],
    })
    expect(session.surface.nodes).not.toContain(originalSeq)

    // Shadow-price protocol: the metering event sits directly before the
    // replacement and prices the shadowed node with the shared estimator.
    if (original.type !== 'tool/result') throw new Error('original is not a tool/result')
    expect(session.snapshotEvents()[entry.replacementSeq - 1]).toMatchObject({
      type: 'compaction/prune',
      data: {
        shadowedRange: { start: originalSeq, end: originalSeq },
        shadowedSeqs: [originalSeq],
        shadowedTokenCount: METER.estimateMessage(original.data.message),
      },
    })
  })

  it('prunes multiple results, skips short ones, and converges in one pass', () => {
    const session = Session.create(SessionId('multiple'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }])
    appendToolStep(session, 2, 'b', [{ type: 'text', text: 'short' }])
    appendToolStep(session, 3, 'c', [{ type: 'text', text: 'C'.repeat(80) }])
    session.append('turn/start', {
      turn: 4,
    })
    const prune = service()
    const first = prune.pruneSession(session)
    const second = prune.pruneSession(session)
    expect(first.pruned.map(entry => entry.callId)).toEqual([ToolCallId('a'), ToolCallId('c')])
    expect(first.charsRemoved).toBe(
      first.pruned.reduce((sum, entry) => sum + entry.charsBefore - entry.charsAfter, 0),
    )
    expect(second).toEqual({ pruned: [], charsRemoved: 0 })
  })

  it('replays to the identical pruned model messages', () => {
    const session = Session.create(SessionId('replay'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }])
    session.append('turn/start', {
      turn: 2,
    })
    service().pruneSession(session)
    const replay = Session.create(session.id, session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    expect(replay.surface.replaceGeneration).toBe(session.surface.replaceGeneration)
  })
})

describe('ToolResultPruner L3 vocabulary hook', () => {
  // Same shape the production tools attach (read.ts/grep.ts/tool-bash): the
  // declaration rides the tool/result meta under PRUNING_META_KEY.
  const declared = (prunable: boolean, bytes: number) => ({
    [PRUNING_META_KEY]: { prunable, bytes },
  })

  it('exempts prunable:false results and leaves no shadow-price events', () => {
    const session = Session.create(SessionId('l3-exempt'))
    const seq = appendToolStep(session, 1, 'kept', [{ type: 'text', text: 'x'.repeat(100) }], {
      meta: declared(false, 100),
    })
    const result = service().pruneSession(session, { byteCapPerResult: toolCapToByteLimit(20) })
    expect(result).toEqual({ pruned: [], charsRemoved: 0 })
    expect(session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
    expect(session.surface.nodes).toContain(seq)
  })

  it('caps declared prunable results by the byte cap and skips results within it', () => {
    const cap = toolCapToByteLimit(20)
    const session = Session.create(SessionId('l3-capped'))
    const within = appendToolStep(session, 1, 'within', [{ type: 'text', text: 'y'.repeat(55) }], {
      meta: declared(true, 55),
    })
    appendToolStep(session, 2, 'over', [{ type: 'text', text: 'z'.repeat(100) }], {
      meta: declared(true, 100),
    })
    const first = service().pruneSession(session, { byteCapPerResult: cap })
    expect(first.pruned.map(entry => entry.callId)).toEqual([ToolCallId('over')])
    expect(first.pruned[0]!.charsAfter).toBeLessThanOrEqual(cap)
    // The declared result within its per-tool budget survives even though it
    // exceeds the uniform threshold: the declaration outranks thresholdChars.
    expect(session.surface.nodes).toContain(within)
    const second = service().pruneSession(session, { byteCapPerResult: cap })
    expect(second).toEqual({ pruned: [], charsRemoved: 0 })
  })

  it('keeps the shadow-price protocol and event-data preservation on declared results', () => {
    const session = Session.create(SessionId('l3-shadow'))
    const originalSeq = appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }], {
      meta: declared(true, 100),
    })
    const result = service().pruneSession(session, { byteCapPerResult: toolCapToByteLimit(20) })
    expect(result.pruned).toHaveLength(1)
    const events = session.snapshotEvents()
    const original = events[originalSeq]!
    if (original.type !== 'tool/result') throw new Error('original is not a tool/result')
    const replacementSeq = result.pruned[0]!.replacementSeq
    // C1/C2/C6: the metering event sits directly before the replacement,
    // prices the shadowed node with the shared estimator, and is log-only.
    expect(events[replacementSeq - 1]).toMatchObject({
      type: 'compaction/prune',
      data: {
        shadowedRange: { start: originalSeq, end: originalSeq },
        shadowedSeqs: [originalSeq],
        shadowedTokenCount: METER.estimateMessage(original.data.message),
      },
    })
    expect((events[replacementSeq - 1] as { surfaceOp?: unknown }).surfaceOp).toBeUndefined()
    // C3/C4/N6: the replacement is the only surface change and the declared
    // meta rides `...event.data` through it.
    expect(events[replacementSeq]).toMatchObject({
      type: 'tool/result',
      surfaceOp: { op: 'replace', startSeq: originalSeq, endSeq: originalSeq },
      sourceEventSeqs: [originalSeq],
      data: { meta: declared(true, 100) },
    })
  })

  it('falls back to the uniform threshold when the meta is absent or malformed', () => {
    const session = Session.create(SessionId('l3-fallback'))
    const plain = appendToolStep(session, 1, 'plain', [{ type: 'text', text: 'B'.repeat(55) }])
    const malformed = appendToolStep(session, 2, 'malformed', [{ type: 'text', text: 'C'.repeat(55) }], {
      meta: { [PRUNING_META_KEY]: 'garbage' },
    })
    const result = service().pruneSession(session, { byteCapPerResult: toolCapToByteLimit(20) })
    expect(result.pruned.map(entry => entry.callId)).toEqual([
      ToolCallId('plain'),
      ToolCallId('malformed'),
    ])
    expect(session.surface.nodes).not.toContain(plain)
    expect(session.surface.nodes).not.toContain(malformed)
  })

  it('falls back to the uniform threshold when the cap cannot represent a replacement', () => {
    const session = Session.create(SessionId('l3-small-cap'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'D'.repeat(100) }], {
      meta: declared(true, 100),
    })
    // A cap below head + marker + tail cannot hold a valid replacement, so the
    // uniform budget applies instead of throwing mid-pass; without opts the
    // declared result also lands on the uniform budget.
    const tiny = service().pruneSession(session, { byteCapPerResult: 10 })
    expect(tiny.pruned[0]).toMatchObject({
      charsBefore: 100,
      charsAfter: 4 + codePointLength(PRUNE_MARKER) + 3,
    })
    const noOpts = service().pruneSession(session)
    expect(noOpts).toEqual({ pruned: [], charsRemoved: 0 })
  })
})
