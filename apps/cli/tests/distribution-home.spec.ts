/**
 * One distribution per data root: three products ship from these sources, and
 * the silent default home belongs to the official one.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { bindDistributionHome, findDistributionRoot } from '../src/distribution-home.ts'

/** A checkout-shaped fixture: `<root>/zdsh-factory/seed.json` plus `<root>/apps/cli/lib`. */
function checkout(withSeed: boolean): { root: string; moduleUrl: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dist-home-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const moduleDir = join(root, 'apps', 'cli', 'lib')
  mkdirSync(moduleDir, { recursive: true })
  if (withSeed) {
    mkdirSync(join(root, 'zdsh-factory'))
    writeFileSync(join(root, 'zdsh-factory', 'seed.json'), '{"version":1,"entries":[]}\n')
  }
  return { root, moduleUrl: pathToFileURL(join(moduleDir, 'bin.js')).href }
}

describe('distribution home binding', () => {
  it('finds the checkout root that carries the factory seed', () => {
    const { root } = checkout(true)
    expect(findDistributionRoot(join(root, 'apps', 'cli', 'lib'))).toBe(root)
  })

  it('does not treat the official layout as a distribution', () => {
    const { root, moduleUrl } = checkout(false)
    expect(findDistributionRoot(join(root, 'apps', 'cli', 'lib'))).toBeUndefined()
    const env: NodeJS.ProcessEnv = {}
    expect(bindDistributionHome(env, moduleUrl)).toBeUndefined()
    expect(env).toEqual({})
  })

  it('binds the checkout data root when no home was selected', () => {
    const { root, moduleUrl } = checkout(true)
    const env: NodeJS.ProcessEnv = {}
    expect(bindDistributionHome(env, moduleUrl)).toBe(root)
    expect(env).toEqual({
      DSH_HOME: join(root, 'data'),
      DSH_BRANCH_HOME: join(root, 'data', 'zdsh'),
      DSH_AGENTS_HOME: join(root, 'data', 'agents'),
    })
  })

  it('never overrides a home the caller selected', () => {
    const { moduleUrl } = checkout(true)
    const env: NodeJS.ProcessEnv = { DSH_HOME: 'D:\\chosen\\home', DSH_AGENTS_HOME: 'D:\\chosen\\agents' }
    expect(bindDistributionHome(env, moduleUrl)).toBeUndefined()
    expect(env).toEqual({ DSH_HOME: 'D:\\chosen\\home', DSH_AGENTS_HOME: 'D:\\chosen\\agents' })
  })

  it('leaves a deliberately shared agents root alone but fills the branch home', () => {
    const { root, moduleUrl } = checkout(true)
    const env: NodeJS.ProcessEnv = { DSH_AGENTS_HOME: 'D:\\shared\\agents' }
    bindDistributionHome(env, moduleUrl)
    expect(env.DSH_HOME).toBe(join(root, 'data'))
    expect(env.DSH_BRANCH_HOME).toBe(join(root, 'data', 'zdsh'))
    expect(env.DSH_AGENTS_HOME).toBe('D:\\shared\\agents')
  })

  it('treats a blank home as unset', () => {
    const { root, moduleUrl } = checkout(true)
    const env: NodeJS.ProcessEnv = { DSH_HOME: '   ' }
    expect(bindDistributionHome(env, moduleUrl)).toBe(root)
    expect(env.DSH_HOME).toBe(join(root, 'data'))
  })
})
