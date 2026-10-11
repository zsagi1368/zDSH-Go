/**
 * Preinstall concurrency suite (TC-B1-1.2b, K-B1): the cross-process writer
 * lock around the seed-read → install → ledger-write critical section.
 *
 * Two proofs:
 *  1. In-process — two gateways over one shared storage root run their passes
 *     concurrently and commit through the same lock, yielding a single valid,
 *     idempotently-merged ledger row and no lingering lock file.
 *  2. Cross-process — a spawned real Node process contends for the lock while
 *     this process holds it, and times out: the `wx` sibling lock genuinely
 *     serialises across OS processes, not just within one event loop.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import PluginGovernanceGateway, { type PluginGovernanceId } from '../src/index.ts'

const storageRoots: string[] = []
const dirs: string[] = []
const contexts: Context[] = []
const seedFiles: string[] = []
let seedSeq = 0

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of storageRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const file of seedFiles.splice(0)) rmSync(file, { force: true })
})

/** Brand a raw id for gateway calls. */
function gid(value: string): PluginGovernanceId {
  return value as PluginGovernanceId
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preinstall-lock-'))
  dirs.push(dir)
  return dir
}

function localPluginDir(name: string): string {
  const dir = scratch()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    displayName: 'Demo Local',
    dsh: {
      autoApprove: true,
      compatible: '>=0.0.0',
      capabilities: [{ type: 'tool', tool: { name: 'demo_local_tool', description: 'fixture', schema: { type: 'object' } } }],
    },
  }))
  return dir
}

// F7 fixture root-posture migration (TC-B4-H1 face 6): seed file sits
// directly under the tmpdir root so deriveRepoRoot anchors repoRoot=tmpdir —
// the scratch plugin dirs (also under tmpdir) stay strictly inside the
// containment root. Row shapes and assertions untouched.
function writeSeed(entries: unknown[]): string {
  const path = join(tmpdir(), `preinstall-lock-seed-${process.pid}-${seedSeq++}.json`)
  seedFiles.push(path)
  writeFileSync(path, JSON.stringify({ version: 1, entries }))
  return path
}

/** Construct a gateway on a shared storage root and run service init. */
async function boot(storageRoot: string, seedPath: string): Promise<PluginGovernanceGateway> {
  const ctx = new Context()
  contexts.push(ctx)
  const gateway = new PluginGovernanceGateway(ctx, { storageRoot, seedPath })
  const self = gateway as unknown as Record<symbol, () => Promise<void>>
  await self[Service.init]!.call(self)
  return gateway
}

describe('preinstall writer lock', () => {
  it('serialises two concurrent gateway passes into one valid ledger row', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'gov-shared-'))
    storageRoots.push(storageRoot)
    const localDir = localPluginDir('@demo/local')
    const seedPath = writeSeed([{
      id: 'demo/local', package: '@demo/local', version: '1.0.0', pin: 'b'.repeat(40),
      source: `local:${localDir}`, integrity: null, enabledAtBoot: true, family: 'demo', failPolicy: 'fail-open',
    }])
    const resultsPath = join(storageRoot, 'data', 'preinstall-results.json')

    const [g1, g2] = [await boot(storageRoot, seedPath), await boot(storageRoot, seedPath)]
    // Fire both passes together; the lock serialises their commits.
    await Promise.all([g1.settlePreinstall(), g2.settlePreinstall()])

    const ledger = JSON.parse(readFileSync(resultsPath, 'utf8')) as {
      entries: Record<string, { status: string }>
    }
    expect(Object.keys(ledger.entries)).toEqual(['demo/local'])
    expect(ledger.entries['demo/local']?.status).toBe('installed')
    // No lock sibling is left behind after both passes settle.
    expect(existsSync(`${resultsPath}.lock`)).toBe(false)
    // Both processes' own registries ended with the plugin.
    for (const g of [g1, g2]) {
      expect(g.list().plugins.some(p => p.pluginId === gid('demo/local'))).toBe(true)
    }
  })

  it('genuinely blocks a competing OS process holding the same lock', () => {
    // A real second Node process tries to take the lock while THIS process
    // holds it; it must time out rather than enter the critical section.
    const target = join(scratch(), 'shared.json')
    const childScript = join(scratch(), 'contender.mjs')
    const atomicWrite = pathToFileURL(
      fileURLToPath(new URL('../../../util/atomic-write/lib/index.js', import.meta.url)),
    ).href
    writeFileSync(childScript, [
      `const { withFileLock } = await import(${JSON.stringify(atomicWrite)})`,
      'const target = process.argv[2]',
      'const waitMs = Number(process.argv[3])',
      'try {',
      '  await withFileLock(target, async () => { throw new Error("ENTERED") }, { waitMs })',
      '  process.stdout.write("ACQUIRED")',
      '  process.exit(0)',
      '} catch (error) {',
      '  process.stdout.write(String(error && error.message))',
      '  process.exit(error instanceof Error && /ENTERED/.test(error.message) ? 0 : 3)',
      '}',
      '',
    ].join('\n'))

    const holder = withFileLock(target, async () => {
      const child = spawnSync(process.execPath, [childScript, target, '700'], { encoding: 'utf8' })
      return child
    }, { waitMs: 2000 })

    // The child cannot report ENTERED/ACQUIRED while we hold the lock: it
    // reports a writer-lock timeout instead.
    return holder.then((child) => {
      expect(child.status).toBe(3)
      expect(child.stdout).toMatch(/timed out waiting for the writer lock/)
      expect(child.stdout).not.toMatch(/ENTERED/)
    })
  })
})
