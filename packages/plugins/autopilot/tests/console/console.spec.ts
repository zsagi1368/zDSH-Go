import { describe, expect, it } from 'vitest'
import { executeCommand } from '../../src/console/commands.js'
import type { ConsoleStatePort } from '../../src/console/commands.js'
import { ConsoleState, performBridgeAction, PRESET_PATCHES } from '../../src/console/bridge.js'
import { createKernel } from '../../src/kernel/facade.js'
import { zh, en } from '../../src/shared-client/locales.js'

function state() {
  const kernel = createKernel({})
  const enabled = new Map([['continue', true], ['guard', true], ['review', false]])
  const cs = new ConsoleState({
    kernel,
    moduleEnabled: id => enabled.get(id) ?? false,
    setModuleEnabled: (id, on) => enabled.set(id, on),
  })
  return { kernel, cs: cs as unknown as ConsoleStatePort, enabled, raw: cs }
}

const t = (key: string): string =>
  key === 'cmd.status.enabled' ? 'on' : key === 'cmd.status.disabled' ? 'off' : key

describe('/ap command surface', () => {
  it('status reports module states and today counters', () => {
    const { cs } = state()
    const out = executeCommand('status', cs, t)
    expect(out.lines.join(' ')).toContain('continue')
    expect(out.lines.join(' ')).toContain('review=off')
  })

  it('on/off targets one module or all', () => {
    const { cs, enabled } = state()
    executeCommand('off review', cs, t)
    expect(enabled.get('review')).toBe(false)
    executeCommand('on review', cs, t)
    expect(enabled.get('review')).toBe(true)
    executeCommand('off', cs, t)
    expect([...enabled.values()].every(v => v === false)).toBe(true)
  })

  it('pause/resume flips global pause through the coordinator', () => {
    const { cs, kernel } = state()
    executeCommand('pause 1h', cs, t)
    expect(kernel.coordinator.paused).toBe(true)
    executeCommand('resume', cs, t)
    expect(kernel.coordinator.paused).toBe(false)
  })

  it('preset applies config patches through kernel.setConfig', () => {
    const { cs, kernel } = state()
    executeCommand('preset fullspeed', cs, t)
    expect(kernel.config().continue.cooldownMs).toBe(
      (PRESET_PATCHES['fullspeed'] as { continue: { cooldownMs: number } }).continue.cooldownMs,
    )
    const bogus = executeCommand('preset bogus', cs, t)
    expect(bogus.lines[0]).toContain('presets:')
  })

  it('help lists subcommands; unknown input falls back to help', () => {
    const { cs } = state()
    expect(executeCommand('help', cs, t).lines.length).toBeGreaterThan(1)
    expect(executeCommand('wibble', cs, t).lines.length).toBeGreaterThan(1)
  })
})

describe('bridge action endpoint', () => {
  const calls: string[] = []
  let approveCalled = false
  function hooks() {
    return {
      resumeSession: (id: string) => calls.push(`resume:${id}`),
      pauseSession: (id: string, ms: number) => calls.push(`pause:${id}:${ms}`),
      approveLatest: () => approveCalled,
    }
  }

  it('rejects unauthorized callers before parsing anything', () => {
    const { cs } = state()
    const verdict = performBridgeAction(JSON.stringify({ action: 'resume' }), cs, () => false, hooks())
    expect(verdict.ok).toBe(false)
    expect(verdict.error).toBe('unauthorized')
    expect(calls).toHaveLength(0)
  })

  it('rejects oversized payloads even when authorized', () => {
    const { cs } = state()
    const verdict = performBridgeAction('x'.repeat(5000), cs, () => true, hooks())
    expect(verdict.error).toBe('payload too large')
  })

  it('performs resume/pause with session routing when authorized', () => {
    const { cs, kernel } = state()
    expect(performBridgeAction({ action: 'resume', sessionId: 's9' }, cs, () => true, hooks()).ok).toBe(true)
    expect(calls).toContain('resume:s9')
    performBridgeAction({ action: 'pause1h', sessionId: 's9' }, cs, () => true, hooks())
    expect(kernel.coordinator.paused).toBe(true)
  })

  it('approve-latest surfaces hook failure as ok:false', () => {
    const { cs } = state()
    approveCalled = false
    expect(performBridgeAction({ action: 'approve-latest' }, cs, () => true, hooks()).ok).toBe(false)
    approveCalled = true
    expect(performBridgeAction({ action: 'approve-latest' }, cs, () => true, hooks()).ok).toBe(true)
  })
})

describe('locale dictionaries', () => {
  it('en satisfies the full zh key set (zh is the source of truth)', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
