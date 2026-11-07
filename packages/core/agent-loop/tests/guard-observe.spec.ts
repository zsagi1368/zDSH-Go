/**
 * Host-side guard-observation chain maintenance (T3 L5-A): the observer
 * appends log-only `cache/guard-observe` events with the classification the
 * interpreter produced, scans transition marks from the real session log
 * window, and warns on unclassified forms — all against a live in-memory
 * Session.
 *
 * @module @deepseek-ai/dsh-agent-loop/tests/guard-observe
 */
import { describe, expect, it, vi } from 'vitest'
import type { LlmGuardMessageKind, LlmGuardObserveCapture, LlmGuardObserveMeta } from '@deepseek-ai/dsh-llm'
import { GuardObserver } from '../src/guard-observe.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const META: LlmGuardObserveMeta = { provider: 'p', api: 'anthropic-messages', modelId: 'm', bodyBytes: 64 }
const hash = (label: string): string => `hash(${label})`

function capture(attemptSeq: number, hashes: string[], kinds: LlmGuardMessageKind[] = hashes.map(() => 'normal')): LlmGuardObserveCapture {
  return {
    schemaVersion: 1,
    attemptSeq,
    wholeHash: hash('whole'),
    segments: {
      systemHash: hash('system'),
      toolsHash: hash('tools'),
      messagesHash: hashes.join('|'),
      messageHashes: hashes,
      messageKinds: kinds,
    },
    meta: META,
  }
}

const guardEvents = (session: Session): Extract<SessionEvent, { type: 'cache/guard-observe' }>[] => {
  return session.snapshotEvents().filter((event): event is Extract<SessionEvent, { type: 'cache/guard-observe' }> => event.type === 'cache/guard-observe')
}

describe('GuardObserver (T3 L5-A host chain)', () => {
  it('records the first capture as RECORD_ONLY and extends the chain monotonically', () => {
    const session = Session.create(SessionId('guard-observe-ok'))
    const warn = vi.fn()
    const observer = new GuardObserver(session, warn)
    observer.observe(capture(1, [hash('a')]))
    observer.observe(capture(1, [hash('a'), hash('b')]))
    const events = guardEvents(session)
    expect(events).toHaveLength(2)
    expect(events[0]?.data).toMatchObject({ classified: true })
    expect(events[0]?.data.monotonic).toBeUndefined()
    expect(events[1]?.data).toMatchObject({ monotonic: 'ok', sharedPrefixCount: 1 })
    expect(events[1]?.seq).toBe((events[0]?.seq ?? 0) + 1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reads compaction marks from the session log window (real scan)', () => {
    const session = Session.create(SessionId('guard-observe-compaction'))
    const observer = new GuardObserver(session, vi.fn())
    observer.observe(capture(1, [hash('a')]))
    // Test doubles for the compaction marks: the CompactionId brand is
    // compile-time only, and this spec does not otherwise depend on the
    // compaction package.
    session.append('compaction/start', { compactionId: 'c1', turn: null } as never)
    session.append('compaction/end', { compactionId: 'c1', turn: null } as never)
    observer.observe(capture(1, [hash('a'), hash('rewritten')]))
    const events = guardEvents(session)
    expect(events[1]?.data).toMatchObject({
      classified: true,
      monotonic: 'ok-after-reset',
      transition: { kind: 'compaction' },
    })
    expect(events[1]?.data.sharedPrefixCount).toBeUndefined()
  })

  it('reads a tailMerge mark (cache/ledger presence) as reset-rewrite without parsing the ledger', () => {
    const session = Session.create(SessionId('guard-observe-ledger'))
    const observer = new GuardObserver(session, vi.fn())
    observer.observe(capture(1, [hash('a')]))
    session.append('cache/ledger', { ledger: '{}', resetWriteCost: 0 })
    observer.observe(capture(1, [hash('rewritten')]))
    const events = guardEvents(session)
    expect(events[1]?.data.transition).toEqual({ kind: 'reset-rewrite' })
  })

  it('marks the gap after a degraded capture and still concludes the chain', () => {
    const session = Session.create(SessionId('guard-observe-gap'))
    const observer = new GuardObserver(session, vi.fn())
    observer.observe(capture(1, [hash('a')]))
    observer.observe({ schemaVersion: 1, attemptSeq: 1, degraded: { reason: 'parse-failed' }, meta: META })
    observer.observe(capture(1, [hash('a'), hash('b')]))
    const events = guardEvents(session)
    expect(events[1]?.data).toMatchObject({ classified: false, degraded: { reason: 'parse-failed' } })
    expect(events[1]?.data.wholeHash).toBeUndefined()
    expect(events[2]?.data).toMatchObject({ monotonic: 'ok', chainGap: true, sharedPrefixCount: 1 })
  })

  it('classifies a strict-tools rebuild attempt within the request (class-4)', () => {
    const session = Session.create(SessionId('guard-observe-attempt'))
    const observer = new GuardObserver(session, vi.fn())
    const first = capture(1, [hash('m1')])
    const rebuild = capture(2, [hash('m1')])
    rebuild.segments = { ...rebuild.segments!, toolsHash: hash('tools-downgraded') }
    observer.observe(first)
    observer.observe(rebuild)
    const events = guardEvents(session)
    expect(events[1]?.data).toMatchObject({ classified: true, classId: 'class4-strict-downgrade', attemptSeq: 2 })
    expect(events[1]?.data.monotonic).toBeUndefined()
  })

  it('warns on an unclassified form and still appends the full record', () => {
    const session = Session.create(SessionId('guard-observe-warn'))
    const warn = vi.fn()
    const observer = new GuardObserver(session, warn)
    observer.observe(capture(1, [hash('a')]))
    observer.observe(capture(1, [hash('rewritten')]))
    const events = guardEvents(session)
    expect(events[1]?.data).toMatchObject({ classified: false, monotonic: 'unclassified' })
    expect(events[1]?.data.segments?.messageHashes).toEqual([hash('rewritten')])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('unclassified')
  })

  it('starts a fresh chain after resume (no log replay of the chain base)', () => {
    const session = Session.create(SessionId('guard-observe-resume'))
    const observer = new GuardObserver(session, vi.fn())
    observer.observe(capture(1, [hash('first-after-resume')]))
    const events = guardEvents(session)
    expect(events[0]?.data).toMatchObject({ classified: true })
    expect(events[0]?.data.monotonic).toBeUndefined()
  })
})
