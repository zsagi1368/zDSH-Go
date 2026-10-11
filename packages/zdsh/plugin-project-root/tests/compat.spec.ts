/**
 * Direct locks on the project-root compat guard's `cannot import` catch
 * branches (MAIN-HYGIENE, sync-017 DEBT rulings §7).
 *
 * The catches are the fail-soft verdict paths for whole-module absence
 * (partial install / registry drift / a symbol removal cascading into a load
 * failure): the guard must disable the feature without throwing, and the
 * roster reason must keep the literal `cannot import …` prefix — the audit
 * attribution face the P2+ roster evidence chain relies on. Pattern copied
 * from the proven model-slots tests/compat.spec.ts shape (`vi.doMock` +
 * `vi.resetModules` + recordingLogger); zero src changes.
 *
 * Probe isolation: deps run in declaration order and short-circuit on the
 * first failure, so each test pins the earlier probes to passing shapes — the
 * lock stays on the catch under test regardless of what the real environment
 * resolves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCompatRoster } from '@deepseek-ai/dsh-compat'
import type { CompatLogger } from '@deepseek-ai/dsh-compat'
import { guardProjectRoot } from '../src/compat.ts'

const CORDIS_MODULE = '@deepseek-ai/cordis'
const GOVERNANCE_MODULE = '@deepseek-ai/dsh-plugin-governance'
const TOOLS_MODULE = '@deepseek-ai/dsh-tools'

function recordingLogger(sink: string[]): CompatLogger {
  return { warn: (message: string) => { sink.push(message) } }
}

/** Passing shape for the cordis probe (typeof Service === 'function'). */
function passingCordisShape(): { Service: unknown } {
  return {
    // One member keeps the shape clear of oxlint no-extraneous-class (the
    // official model-slots negative-control precedent); the probe itself only
    // checks typeof Service === 'function'.
    Service: class {
      probeShape(): undefined {
        return undefined
      }
    },
  }
}

/** Passing shape for the governance probe (typeof LoadGuard === 'function'). */
function passingGovernanceShape(): { LoadGuard: unknown } {
  return {
    LoadGuard: class {
      probeShape(): undefined {
        return undefined
      }
    },
  }
}

afterEach(() => {
  vi.doUnmock(CORDIS_MODULE)
  vi.doUnmock(GOVERNANCE_MODULE)
  vi.doUnmock(TOOLS_MODULE)
  // Drop the mocked module instance so the next guard call re-evaluates the
  // real one; bound top-level imports are unaffected.
  vi.resetModules()
})

describe('guardProjectRoot catch branches (DEBT §7)', () => {
  it('fail-softs with the literal reason when the cordis import throws', async () => {
    vi.doMock(CORDIS_MODULE, () => {
      throw new Error('injected module-resolution failure (partial install / registry drift)')
    })

    const warnings: string[] = []
    const enabled = await guardProjectRoot(recordingLogger(warnings))

    expect(enabled).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[compat] dsh-project-root disabled')
    expect(warnings[0]).toContain('cordis:Service')

    const entry = getCompatRoster().get('dsh-project-root')
    expect(entry).toMatchObject({ enabled: false })
    expect(entry?.reason.startsWith('cannot import cordis Service')).toBe(true)
  })

  it('fail-softs with the literal reason when the LoadGuard import throws', async () => {
    vi.doMock(CORDIS_MODULE, () => passingCordisShape())
    vi.doMock(GOVERNANCE_MODULE, () => {
      throw new Error('injected module-resolution failure (partial install / registry drift)')
    })

    const warnings: string[] = []
    const enabled = await guardProjectRoot(recordingLogger(warnings))

    expect(enabled).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[compat] dsh-project-root disabled')
    expect(warnings[0]).toContain('governance:LoadGuard')

    const entry = getCompatRoster().get('dsh-project-root')
    expect(entry).toMatchObject({ enabled: false })
    expect(entry?.reason.startsWith('cannot import LoadGuard')).toBe(true)
  })

  it('fail-softs with the literal reason when the defineTool import throws', async () => {
    vi.doMock(CORDIS_MODULE, () => passingCordisShape())
    vi.doMock(GOVERNANCE_MODULE, () => passingGovernanceShape())
    vi.doMock(TOOLS_MODULE, () => {
      throw new Error('injected module-resolution failure (partial install / registry drift)')
    })

    const warnings: string[] = []
    const enabled = await guardProjectRoot(recordingLogger(warnings))

    expect(enabled).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[compat] dsh-project-root disabled')
    expect(warnings[0]).toContain('tools:defineTool')

    const entry = getCompatRoster().get('dsh-project-root')
    expect(entry).toMatchObject({ enabled: false })
    expect(entry?.reason.startsWith('cannot import defineTool')).toBe(true)
  })
})
