import { describe, expect, it } from 'vitest'
import {
  buildMarker,
  checkVisibility,
  envelope,
  foldAudit,
  initialAuditState,
  makeAuditEvent,
  parseMarkers,
} from '../../src/kernel/audit.js'
import { createTokenSource } from '../../src/kernel/ledger.js'
import type { AuditEvent } from '../../src/kernel/types.js'

const rng = createTokenSource(() => 0.42)
const at = 1_700_000_000_000

function event(name: 'ap/resumed' | 'ap/skipped' | 'ap/circuit', data: unknown): AuditEvent {
  return makeAuditEvent(name, data as never, at, rng) as unknown as AuditEvent
}

describe('markers', () => {
  it('round-trips build → parse', () => {
    const marker = buildMarker('ap/verdict', 'v_abc')
    const parsed = parseMarkers(`prefix ${marker} suffix`)
    expect(parsed).toEqual([{ event: 'ap/verdict', id: 'v_abc' }])
  })

  it('ignores malformed markers and unknown families', () => {
    expect(parseMarkers('[autopilot:bogus/x] [autopilot:ap/zzz/y]')).toEqual([])
  })
})

describe('envelope + folds', () => {
  it('wraps events in the ignorable envelope shape', () => {
    const env = envelope('ap/state', { enabled: true, modules: { continue: true, guard: true, review: false }, source: 'user' })
    expect(env.options).toEqual({ ignorable: true })
    expect(env.type).toBe('ap/state')
  })

  it('folds state toggles, grants, overrides, circuit, verdicts', () => {
    let state = initialAuditState()
    const push = (name: Parameters<typeof makeAuditEvent>[0], data: unknown) => {
      state = foldAudit(state, makeAuditEvent(name, data as never, at, rng) as unknown as AuditEvent)
    }

    push('ap/state', { enabled: false, modules: {}, source: 'cmd' })
    expect(state.enabled).toBe(false)

    push('ap/grant', { grantId: 'g1', phase: 'issued' })
    push('ap/grant', { grantId: 'g1', phase: 'consumed' })
    expect(state.grants['g1']?.phase).toBe('consumed')

    push('ap/override', { overrideId: 'o1', toolName: 'bash', ttlMs: 1000, phase: 'issued' })
    expect(state.overrides['o1']?.toolName).toBe('bash')

    push('ap/circuit', { action: 'delegate', consecutiveDenials: 3, windowDenials: 6, windowSize: 10 })
    expect(state.circuit.tripped).toBe(true)

    push('ap/verdict', { verdictId: 'v1', decision: 'deny' })
    push('ap/verdict', { verdictId: 'v2', decision: 'allow', fallback: 'timeout' })
    expect(state.lastVerdicts.map(v => v.verdictId)).toEqual(['v1', 'v2'])
    expect(state.counters['ap/verdict']).toBe(2)
  })
})

describe('visibility invariant (model-visible ⟺ recorded)', () => {
  it('catches markers whose events were never logged', () => {
    const report = checkVisibility(
      ['denied: [autopilot:ap/verdict/v_missing] reason'],
      [],
      new Set(),
    )
    expect(report.markersWithoutEvents).toEqual([{ event: 'ap/verdict', id: 'v_missing' }])
  })

  it('catches visible events whose marker never reached any text', () => {
    const visible = new Set([`ap/verdict#${'v_lost'}`])
    const report = checkVisibility(
      ['no markers here'],
      [
        {
          name: 'ap/verdict',
          id: 'v_lost',
          at,
          data: { verdictId: 'v_lost', decision: 'deny' },
        },
      ],
      visible,
    )
    expect(report.eventsWithoutMarkers).toEqual(['ap/verdict'])
  })

  it('passes when every visible event has its marker recorded', () => {
    const id = `v_${at.toString(36)}_${rng.token()}`
    const text = `[autopilot:ap/verdict/${id}] denied`
    const report = checkVisibility(
      [text],
      [{ name: 'ap/verdict', id, at, data: { verdictId: id, decision: 'deny' } }],
      new Set([`ap/verdict#${id}`]),
    )
    expect(report.markersWithoutEvents).toHaveLength(0)
    expect(report.eventsWithoutMarkers).toHaveLength(0)
  })

  it('smoke: helper event builder produces foldable envelopes', () => {
    const ev = event('ap/skipped', { sessionId: 's', reason: 'cooldown' })
    expect(ev.name).toBe('ap/skipped')
    const folded = foldAudit(initialAuditState(), ev)
    expect(folded.counters['ap/skipped']).toBe(1)
  })
})
