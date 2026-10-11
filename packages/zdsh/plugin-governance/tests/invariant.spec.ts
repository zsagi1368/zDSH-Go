/**
 * Invariant companion suite: the persisted admission posture must be
 * re-checkable on every process start, independent of the live registry.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })

  delete process.env.DSH_BRANCH_HOME
  vi.restoreAllMocks()
})

/** Capture the installer through the real apply() registration path. */
async function installer(): Promise<(ctx: never, fail: ReturnType<typeof vi.fn>) => void> {
  let captured: ((ctx: never, fail: ReturnType<typeof vi.fn>) => void) | undefined
  const ctx = {
    invariants: {
      register: vi.fn((_packageName: string, registered: (ctx: never, fail: ReturnType<typeof vi.fn>) => void) => {
        captured = registered
        return () => {}
      }),
    },
  }
  await apply(ctx as never)
  if (captured === undefined) throw new Error('apply did not register the invariant')
  return captured
}

/** A throwaway branch home carrying a registry/approvals fixture. */
function fixtureHome(registry: unknown, approvals?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'gov-inv-'))
  homes.push(home)
  process.env.DSH_BRANCH_HOME = home
  // registry.json lives at the storage root (PluginPersistence.save);
  // approvals.json lives under data/ (host saveApprovals).
  writeFileSync(join(home, 'registry.json'), JSON.stringify(registry))
  if (approvals !== undefined) {
    const data = join(home, 'data')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'approvals.json'), JSON.stringify(approvals))
  }
  return home
}

function activeEntry(id: string, permissionLevel?: unknown, autoApprove?: unknown): unknown {
  return {
    id,
    name: id,
    version: '1.0.0',
    status: 'active',
    manifest: {
      permissionLevel,
      ...(autoApprove === undefined ? {} : { autoApprove }),
    },
  }
}

describe('plugin-governance invariant companion', () => {
  it('exposes the canonical companion contract', () => {
    expect(name).toBe('plugin-governance-invariant')
    expect(inject).toEqual(['invariants'])
    expect(typeof apply).toBe('function')
  })

  it('reports an active plugin that never received an admission decision', async () => {
    fixtureHome({ version: '1.0.0', plugins: [activeEntry('demo/plugin')] }, { approvedAt: {} })
    const fail = vi.fn()
    const install = await installer()
    install({} as never, fail)
    expect(fail).toHaveBeenCalledTimes(1)
    expect(String(fail.mock.calls[0]?.[0])).toContain('demo/plugin')
  })

  it('silences plugins with a recorded approval, auto-approve, or no decision need', async () => {
    fixtureHome(
      {
        version: '1.0.0',
        plugins: [
          activeEntry('calm/approved', 'confirm-required'),
          activeEntry('calm/auto', undefined, true),
          activeEntry('calm/unrestricted', 'user'),
        ],
      },
      { approvedAt: { 'calm/approved': 1_700_000_000_000 } },
    )
    const fail = vi.fn()
    const install = await installer()
    install({} as never, fail)
    expect(fail).not.toHaveBeenCalled()
  })

  it('ignores disabled entries, non-matching statuses, and missing files', async () => {
    fixtureHome({
      version: '1.0.0',
      plugins: [
        { id: 'calm/off', status: 'disabled', manifest: {} },
        { id: 'calm/error', status: 'error', manifest: {} },
      ],
    })
    const fail = vi.fn()
    const install = await installer()
    install({} as never, fail)
    expect(fail).not.toHaveBeenCalled()

    // 无任何持久化文件：无姿势可报，静默通过。
    const empty = mkdtempSync(join(tmpdir(), 'gov-inv-empty-'))
    homes.push(empty)
    process.env.DSH_BRANCH_HOME = empty
    expect(existsSync(join(empty, 'data'))).toBe(false)
    install({} as never, fail)
    expect(fail).not.toHaveBeenCalled()
  })

  it('treats a corrupt approvals ledger as no approvals (fail closed)', async () => {
    fixtureHome({ version: '1.0.0', plugins: [activeEntry('sick/corrupt')] }, 'not json{')
    const fail = vi.fn()
    const install = await installer()
    install({} as never, fail)
    expect(fail).toHaveBeenCalledTimes(1)
  })
})
