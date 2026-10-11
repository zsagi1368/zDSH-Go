import { describe, expect, it, vi } from 'vitest'
import {
  consoleCompatLogger,
  getCompatRoster,
  guardFeature,
} from '../src/guard.ts'
import type { CompatCheck, CompatLogger } from '../src/guard.ts'

const passCheck = (name: string): CompatCheck => ({ name, run: vi.fn(() => null) })
const failCheck = (name: string, reason: string): CompatCheck => ({
  name,
  run: vi.fn(() => reason),
})

const makeLogger = (): { logger: CompatLogger; warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn(() => {})
  return { logger: { warn }, warn }
}

describe('guardFeature', () => {
  it('enables a feature when every dep and check passes', async () => {
    const { logger, warn } = makeLogger()
    const deps = [passCheck('dep:a'), passCheck('dep:b')]
    const checks = [passCheck('check:x')]
    const verdict = await guardFeature('all-pass', { deps, check: checks, logger })
    expect(verdict).toEqual({ enabled: true, reason: 'ok', failures: [] })
    expect(deps[0]!.run).toHaveBeenCalledTimes(1)
    expect(checks[0]!.run).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('awaits async check runs', async () => {
    const { logger } = makeLogger()
    const deps: CompatCheck[] = [{ name: 'dep:async', run: vi.fn(async () => null) }]
    const verdict = await guardFeature('async-run', { deps, logger })
    expect(verdict).toEqual({ enabled: true, reason: 'ok', failures: [] })
  })

  it('enables when no deps or checks are configured', async () => {
    const verdict = await guardFeature('empty-options', {})
    expect(verdict).toEqual({ enabled: true, reason: 'ok', failures: [] })
  })

  it('disables on a failing dep and short-circuits the remaining checks', async () => {
    const { logger, warn } = makeLogger()
    const depA = passCheck('dep:a')
    const depB = failCheck('dep:b', 'boom')
    const depC = passCheck('dep:c')
    const check = passCheck('check:x')
    const verdict = await guardFeature('dep-fails', {
      deps: [depA, depB, depC],
      check: [check],
      logger,
    })
    expect(verdict).toEqual({ enabled: false, reason: 'boom', failures: ['dep:b'] })
    expect(depA.run).toHaveBeenCalledTimes(1)
    expect(depB.run).toHaveBeenCalledTimes(1)
    expect(depC.run).not.toHaveBeenCalled()
    expect(check.run).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[compat] dep-fails disabled: dep:b')
  })

  it('disables on a failing check after all deps pass', async () => {
    const { logger } = makeLogger()
    const verdict = await guardFeature('check-fails', {
      deps: [passCheck('dep:a')],
      check: [failCheck('check:conflict', 'duplicate-registration')],
      logger,
    })
    expect(verdict).toEqual({
      enabled: false,
      reason: 'duplicate-registration',
      failures: ['check:conflict'],
    })
  })

  it('classifies a throwing Error run as threw:<message>', async () => {
    const { logger } = makeLogger()
    const deps: CompatCheck[] = [{
      name: 'dep:explode',
      run: vi.fn(() => {
        throw new Error('kaboom')
      }),
    }]
    const verdict = await guardFeature('threw-error', { deps, logger })
    expect(verdict).toEqual({ enabled: false, reason: 'threw:kaboom', failures: ['dep:explode'] })
  })

  it('stringifies a non-Error throw as threw:<stringified>', async () => {
    const { logger } = makeLogger()
    const deps: CompatCheck[] = [{
      name: 'dep:explode',
      run: vi.fn(() => {
        throw 'raw-boom'
      }),
    }]
    const verdict = await guardFeature('threw-string', { deps, logger })
    expect(verdict.reason).toBe('threw:raw-boom')
    expect(verdict.enabled).toBe(false)
  })

  it('never throws even when the logger itself throws', async () => {
    const logger: CompatLogger = {
      warn: vi.fn(() => {
        throw new Error('logger-broken')
      }),
    }
    const verdict = await guardFeature('throwing-logger', {
      deps: [failCheck('dep:a', 'no')],
      logger,
    })
    expect(verdict).toEqual({ enabled: false, reason: 'no', failures: ['dep:a'] })
  })

  it('uses logPrefix in the warning when provided', async () => {
    const { logger, warn } = makeLogger()
    await guardFeature('custom-prefix', {
      deps: [failCheck('dep:a', 'no')],
      logPrefix: 'my-feature',
      logger,
    })
    expect(warn).toHaveBeenCalledWith('[compat] my-feature disabled: dep:a')
  })

  it('defaults the log prefix to the feature id', async () => {
    const { logger, warn } = makeLogger()
    await guardFeature('feature-id-prefix', {
      deps: [failCheck('dep:a', 'no')],
      logger,
    })
    expect(warn).toHaveBeenCalledWith('[compat] feature-id-prefix disabled: dep:a')
  })
})

describe('consoleCompatLogger', () => {
  it('delegates warn and info to console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const logger = consoleCompatLogger()
      logger.warn('w-msg', 1)
      logger.info?.('i-msg', 2)
      expect(warn).toHaveBeenCalledWith('w-msg', 1)
      expect(info).toHaveBeenCalledWith('i-msg', 2)
    } finally {
      warn.mockRestore()
      info.mockRestore()
    }
  })

  it('is used by default for disabled-feature warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await guardFeature('default-logger', { deps: [failCheck('dep:a', 'no')] })
      expect(warn).toHaveBeenCalledWith('[compat] default-logger disabled: dep:a')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('getCompatRoster', () => {
  it('returns an independent snapshot that does not grow retroactively', async () => {
    const before = getCompatRoster()
    await guardFeature('snapshot-entry', { logger: makeLogger().logger })
    const after = getCompatRoster()
    expect(after).not.toBe(before)
    expect(before.has('snapshot-entry')).toBe(false)
    const entry = after.get('snapshot-entry')
    expect(entry).toMatchObject({ enabled: true, reason: 'ok' })
    expect(entry?.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('records disabled verdicts with their failure reason', async () => {
    await guardFeature('roster-disabled', {
      deps: [failCheck('dep:a', 'no')],
      logger: makeLogger().logger,
    })
    const entry = getCompatRoster().get('roster-disabled')
    expect(entry).toMatchObject({ enabled: false, reason: 'no' })
  })
})
