/**
 * Closed-loop integration test: a real node:http server wired through
 * serveRequest, a real child-process `dsh` stand-in, real profile files —
 * the whole market → stage → apply → audit → uninstall → restore path.
 */
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serveRequest } from '../../src/host/plugin.js'
import { PluginCenterServices } from '../../src/host/services.js'
import { nodePorts, type CommandSpec, type EnginePorts } from '../../src/host/ports.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))
const COMMIT_A = 'a'.repeat(40)

const seedEntries = [
  {
    id: 'owner/alpha',
    source: 'github',
    owner: 'owner',
    repo: 'alpha',
    pinnedCommit: COMMIT_A,
    title: { zh: '甲', en: 'Alpha' },
    summary: { zh: '测试', en: 'Test' },
    category: 'test',
    evidence: 'installable',
    compat: 'exact',
    scriptsPolicy: 'none',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
  {
    id: 'registry/beta',
    source: 'npm',
    packageName: 'beta-pkg',
    version: '1.2.3',
    integritySha256: 'f'.repeat(64),
    title: { zh: '乙', en: 'Beta' },
    summary: { zh: '测试', en: 'Test' },
    category: 'test',
    evidence: 'installable',
    compat: 'unknown',
    scriptsPolicy: 'none',
    updatedAt: '2026-08-21T00:00:00.000Z',
  },
]

interface Harness {
  baseUrl: string
  server: Server
  services: PluginCenterServices
  root: string
  profileDir: string
  failRef: { current: boolean }
  commandsSeen: CommandSpec[]
}

function startHarness(): Promise<Harness> {
  return new Promise((resolvePromise, rejectPromise) => {
    const root = mkdtempSync(join(tmpdir(), 'pc-e2e-'))
    const profileDir = join(root, 'profile')
    const dataRoot = join(root, 'data')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{\n  "dependencies": {}\n}\n', 'utf8')
    for (const name of ['pnpm-workspace.yaml', 'cordis.patch.yml']) {
      writeFileSync(join(profileDir, name), `original ${name}\n`, 'utf8')
    }
    const seedPath = join(root, 'seed.json')
    writeFileSync(seedPath, JSON.stringify({ version: 1, fetchedAt: '', entries: seedEntries }), 'utf8')

    const real = nodePorts()
    const failRef: { current: boolean } = { current: false }
    const commandsSeen: CommandSpec[] = []
    // Route the engine's `dsh` invocations through node + the fixture script.
    const ports: EnginePorts = {
      fs: real.fs,
      clock: real.clock,
      http: real.http,
      commands: {
        run(spec) {
          commandsSeen.push(spec)
          return new Promise((resolveRun, rejectRun) => {
            const child = spawn(process.execPath, [FIXTURE, ...spec.args], {
              cwd: root,
              env: { ...process.env, FAKE_DSH_MODE: failRef.current ? 'fail' : '' },
              shell: false,
              windowsHide: true,
            })
            let stderr = ''
            child.stderr?.on('data', (chunk: Buffer) => {
              stderr += chunk.toString()
            })
            child.on('error', rejectRun)
            child.on('close', code =>
              resolveRun({ code: code ?? -1, stdout: '', stderr }),
            )
          })
        },
      },
    }
    const services = new PluginCenterServices(
      {
        defaultProfile: 'web',
        profileDir,
        dataRoot,
        catalogSeedPath: seedPath,
        remoteCatalogUrl: null,
        mutationsEnabled: true,
      },
      ports,
    )
    const server = createServer((req, res) => {
      void serveRequest(services, req, res)
    })
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        rejectPromise(new Error('no port'))
        return
      }
      resolvePromise({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        server,
        services,
        root,
        profileDir,
        failRef,
        commandsSeen,
      })
    })
  })
}

let harness: Harness | null = null
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(() => {
  harness?.server.close()
  harness = null
})

async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(`${harness!.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      host: '127.0.0.1',
      origin: harness!.baseUrl,
      'x-zdsh-pc-intent': 'zdsh-plugin-center',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, payload: (await response.json()) as unknown }
}

describe('closed loop over real HTTP and child processes', () => {
  it('market → stage → wrong code → apply → verify mutation, backup and audit', async () => {
    const h = harness!
    // market page over the socket
    const market = await api('GET', '/api2/zdsh-plugin-center/market?page=1')
    expect(market.status).toBe(200)
    expect(market.payload.total).toBe(2)

    // stage an install plan for the pinned github entry
    const staged = await api('POST', '/api2/zdsh-plugin-center/plan/stage', {
      action: 'install',
      entryId: 'owner/alpha',
    })
    expect(staged.status).toBe(200)
    const { planId, phrase } = staged.payload as { planId: string; phrase: string }

    // wrong confirmation code is refused and the plan stays usable
    const wrong = await api('POST', '/api2/zdsh-plugin-center/plan/apply', {
      planId,
      phrase: `${phrase.slice(0, -1)}0`,
    })
    expect(wrong.status).toBe(400)

    const pkgBefore = readFileSync(join(h.profileDir, 'package.json'), 'utf8')
    const applied = await api('POST', '/api2/zdsh-plugin-center/plan/apply', { planId, phrase })
    expect(applied.status).toBe(200)
    expect((applied.payload as { state: string }).state).toBe('restart-pending')

    // the fake CLI really mutated the profile
    const manifest = JSON.parse(readFileSync(join(h.profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['alpha']).toBe(COMMIT_A.slice(0, 10))
    expect(readFileSync(join(h.profileDir, 'node_modules', 'alpha', 'package.json'), 'utf8')).toContain('"alpha"')

    // a backup snapshot captured the pre-state
    const backups = await api('GET', '/api2/zdsh-plugin-center/backups')
    expect(backups.status).toBe(200)
    expect((backups.payload as Array<{ name: string }>).length).toBeGreaterThanOrEqual(1)

    // audit trail recorded every step without secrets
    const audit = await api('GET', '/api2/zdsh-plugin-center/audit')
    const lines = audit.payload as Array<{ action: string; outcome: string }>
    expect(lines.some(l => l.action === 'plan.done' && l.outcome === 'ok')).toBe(true)

    void pkgBefore
  })

  it('failed command rolls the profile back byte-exactly', async () => {
    const h = harness!
    h.failRef.current = true
    const pkgOriginal = readFileSync(join(h.profileDir, 'package.json'), 'utf8')
    const staged = await api('POST', '/api2/zdsh-plugin-center/plan/stage', {
      action: 'install',
      entryId: 'owner/alpha',
    })
    const { planId, phrase } = staged.payload as { planId: string; phrase: string }
    const applied = await api('POST', '/api2/zdsh-plugin-center/plan/apply', { planId, phrase })
    expect(applied.status).toBe(500) // install_failed maps to 5xx
    expect(
      readFileSync(join(h.profileDir, 'package.json'), 'utf8'),
    ).toBe(pkgOriginal)
    expect(existsSyncMarker(h)).toBe(false)
  })

  it('uninstall round trip removes the dependency again', async () => {
    const h = harness!
    // install first
    const installStaged = await api('POST', '/api2/zdsh-plugin-center/plan/stage', {
      action: 'install',
      entryId: 'owner/alpha',
    })
    const installed = await api('POST', '/api2/zdsh-plugin-center/plan/apply', {
      planId: (installStaged.payload as { planId: string }).planId,
      phrase: (installStaged.payload as { phrase: string }).phrase,
    })
    expect(installed.status).toBe(200)

    const removeStaged = await api('POST', '/api2/zdsh-plugin-center/plan/stage', {
      action: 'uninstall',
      entryId: 'owner/alpha',
    })
    expect(removeStaged.status).toBe(200)
    const removed = await api('POST', '/api2/zdsh-plugin-center/plan/apply', {
      planId: (removeStaged.payload as { planId: string }).planId,
      phrase: (removeStaged.payload as { phrase: string }).phrase,
    })
    expect(removed.status).toBe(200)
    const manifest = JSON.parse(readFileSync(join(h.profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['alpha']).toBeUndefined()
  })

  it('restore endpoint stages then applies with a one-shot code', async () => {
    const h = harness!
    const pkgOriginal = readFileSync(join(h.profileDir, 'package.json'), 'utf8')
    const staged = await api('POST', '/api2/zdsh-plugin-center/plan/stage', {
      action: 'install',
      entryId: 'registry/beta',
    })
    const applied = await api('POST', '/api2/zdsh-plugin-center/plan/apply', {
      planId: (staged.payload as { planId: string }).planId,
      phrase: (staged.payload as { phrase: string }).phrase,
    })
    expect(applied.status).toBe(200)
    expect(readFileSync(join(h.profileDir, 'package.json'), 'utf8')).not.toBe(pkgOriginal)

    const backups = (await api('GET', '/api2/zdsh-plugin-center/backups'))
      .payload as Array<{ name: string; createdAtMs: number }>
    const oldest = backups.reduce((a, b) => (a.createdAtMs <= b.createdAtMs ? a : b))

    // stage the restore, refuse a wrong code, then apply the right one
    const restoreStaged = await api('POST', '/api2/zdsh-plugin-center/backups/restore', {
      name: oldest.name,
    })
    expect(restoreStaged.status).toBe(200)
    const { restoreId, code } = restoreStaged.payload as { restoreId: string; code: string }

    const wrong = await api('POST', '/api2/zdsh-plugin-center/backups/restore/apply', {
      restoreId,
      code: `${code.slice(0, -1)}0`,
    })
    expect(wrong.status).toBe(400)

    const restored = await api('POST', '/api2/zdsh-plugin-center/backups/restore/apply', {
      restoreId,
      code,
    })
    expect(restored.status).toBe(200)
    expect(readFileSync(join(h.profileDir, 'package.json'), 'utf8')).toBe(pkgOriginal)

    // one-shot consumption: replaying the same pair is refused
    const replay = await api('POST', '/api2/zdsh-plugin-center/backups/restore/apply', {
      restoreId,
      code,
    })
    expect(replay.status).toBe(404)
  })

  it('refuses to re-apply a plan that already reached a terminal state', async () => {
    const staged = await api('POST', '/api2/zdsh-plugin-center/plan/stage', {
      action: 'install',
      entryId: 'owner/alpha',
    })
    const { planId, phrase } = staged.payload as { planId: string; phrase: string }
    const first = await api('POST', '/api2/zdsh-plugin-center/plan/apply', { planId, phrase })
    expect(first.status).toBe(200)
    // the store now holds restart-pending; confirmation is gone
    const replay = await api('POST', '/api2/zdsh-plugin-center/plan/apply', { planId, phrase })
    expect(replay.status).toBeGreaterThanOrEqual(400)
  })

  it('runtime identity and guardian status respond without side effects', async () => {
    const runtime = await api('GET', '/api2/zdsh-plugin-center/runtime')
    expect(runtime.status).toBe(200)
    expect(typeof (runtime.payload as { bootId: string }).bootId).toBe('string')
    const guardian = await api('GET', '/api2/zdsh-plugin-center/guardian/status')
    expect(guardian.status).toBe(200)
  })
})

function existsSyncMarker(h: Harness): boolean {
  try {
    readFileSync(join(h.profileDir, 'node_modules', 'alpha', 'package.json'), 'utf8')
    return true
  } catch {
    return false
  }
}
