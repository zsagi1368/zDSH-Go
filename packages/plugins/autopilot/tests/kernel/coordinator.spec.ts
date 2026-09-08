import { describe, expect, it } from 'vitest'
import { AutomationCoordinator } from '../../src/kernel/coordinator.js'
import type { CoordinationEvent } from '../../src/kernel/coordinator.js'

function collector(log: string[], moduleId: 'continue' | 'guard' | 'review') {
  return (event: CoordinationEvent) => {
    log.push(`${moduleId}:${event.kind}`)
  }
}

describe('coordinator invariants', () => {
  it('fans events out to every enabled module', () => {
    const coord = new AutomationCoordinator()
    const log: string[] = []
    coord.registerModule('continue', collector(log, 'continue'))
    coord.registerModule('guard', collector(log, 'guard'))
    coord.dispatch({ kind: 'turn-ended', sessionId: 's1', reason: 'error' })
    expect(log).toEqual(['continue:turn-ended', 'guard:turn-ended'])
  })

  it('invariant 3: global pause suppresses resume requests entirely', () => {
    const coord = new AutomationCoordinator()
    const log: string[] = []
    coord.registerModule('continue', collector(log, 'continue'))
    coord.dispatch({ kind: 'pause-change', paused: true })
    log.length = 0 // state-change events fan out too; we only care about resumes
    const outcomes = coord.dispatch({ kind: 'resume-request', sessionId: 's1' })
    expect(outcomes[0]).toEqual({ status: 'suppressed', reason: 'paused' })
    expect(log).toHaveLength(0) // handlers never see a suppressed request
    coord.dispatch({ kind: 'pause-change', paused: false })
    expect(coord.dispatch({ kind: 'resume-request', sessionId: 's1' })[0]?.status).toBe(
      'dispatched',
    )
  })

  it('invariant 1: pending approval defers (not drops) auto-resume for that session', () => {
    const coord = new AutomationCoordinator()
    coord.registerModule('continue', () => {})
    coord.dispatch({ kind: 'approval-pending', sessionId: 's1', callId: 'c1', toolName: 'bash' })
    const outcomes = coord.dispatch({ kind: 'resume-request', sessionId: 's1' })
    expect(outcomes[0]).toEqual({ status: 'deferred', reason: 'pending-approval' })

    // Other sessions are unaffected.
    expect(coord.dispatch({ kind: 'resume-request', sessionId: 's2' })[0]?.status).toBe(
      'dispatched',
    )

    // Resolution re-opens the gate.
    coord.dispatch({ kind: 'approval-resolved', sessionId: 's1', callId: 'c1' })
    expect(coord.dispatch({ kind: 'resume-request', sessionId: 's1' })[0]?.status).toBe(
      'dispatched',
    )
  })

  it('invariant 2: an open review circuit suppresses auto-resume as circuit-open', () => {
    const coord = new AutomationCoordinator()
    coord.registerModule('continue', () => {})
    coord.dispatch({ kind: 'circuit-change', open: true })
    const outcomes = coord.dispatch({ kind: 'resume-request', sessionId: 's1' })
    expect(outcomes[0]).toEqual({ status: 'suppressed', reason: 'circuit-open' })
    coord.dispatch({ kind: 'circuit-change', open: false })
    expect(coord.dispatch({ kind: 'resume-request', sessionId: 's1' })[0]?.status).toBe(
      'dispatched',
    )
  })

  it('invariant 4: one callId is dispositioned exactly once — first claim wins', () => {
    const coord = new AutomationCoordinator()
    const claims: boolean[] = []
    let viewRef: ReturnType<typeof Object> | undefined
    coord.registerModule('guard', (_event, view) => {
      viewRef = view
      claims.push(view.claimCall('call-9'))
      claims.push(view.claimCall('call-9'))
    })
    coord.dispatch({ kind: 'approval-pending', sessionId: 's', callId: 'call-9', toolName: 'x' })
    void viewRef
    expect(claims).toEqual([true, false])
  })

  it('disabled modules are skipped; handler crashes do not break the fanout', () => {
    const coord = new AutomationCoordinator()
    const log: string[] = []
    coord.registerModule('review', () => {
      throw new Error('review exploded')
    })
    coord.registerModule('guard', collector(log, 'guard'))
    coord.setModuleEnabled('review', false)
    const outcomes = coord.dispatch({ kind: 'tool-call' as never } as never)
    void outcomes
    expect(log).toEqual(['guard:tool-call'])

    coord.setModuleEnabled('review', true)
    const after = coord.dispatch({ kind: 'turn-ended', sessionId: 's', reason: 'error' })
    expect(after.some(o => o.status === 'suppressed')).toBe(true)
    expect(log.filter(l => l.startsWith('guard'))).toHaveLength(2)
  })

  it('handlers observe coordination state through the view when allowed through', () => {
    const coord = new AutomationCoordinator()
    const seen: { pending: boolean; paused: boolean; claimed: boolean }[] = []
    coord.registerModule('continue', (event, view) => {
      if (event.kind !== 'resume-request') return
      seen.push({
        pending: view.hasPendingApproval(event.sessionId),
        paused: view.paused,
        claimed: view.claimCall(`claim-${event.sessionId}`),
      })
    })

    // Pending approval → centrally deferred, handler never runs for that session.
    coord.dispatch({ kind: 'approval-pending', sessionId: 'sx', callId: 'cx', toolName: 't' })
    expect(coord.dispatch({ kind: 'resume-request', sessionId: 'sx' })[0]?.status).toBe('deferred')

    // Clear session passes the gate; handler observes clean state.
    coord.dispatch({ kind: 'resume-request', sessionId: 'sy' })
    expect(seen).toEqual([{ pending: false, paused: false, claimed: true }])
  })
})
