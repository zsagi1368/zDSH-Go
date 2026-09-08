import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleApiRequest, INTENT_HEADER, ROUTES } from '../../src/host/api.js'
import { PluginCenterServices } from '../../src/host/services.js'
import { nodePorts, type CommandSpec, type EnginePorts } from '../../src/host/ports.js'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

function entry(id: string, commit: string): unknown {
  return {
    id,
    source: 'github',
    owner: id.split('/')[0],
    repo: id.split('/')[1],
    pinnedCommit: commit,
    title: { zh: `插件 ${id}`, en: `Plugin ${id}` },
    summary: { zh: '测试条目', en: 'Test entry' },
    category: 'test',
    evidence: 'installable',
    compat: 'exact',
    scriptsPolicy: 'none',
    // beta is fresher so it wins the recency tie-break
    updatedAt: id.endsWith('beta') ? '2026-08-21T00:00:00.000Z' : '2026-08-20T00:00:00.000Z',
  }
}

function makeServices(options: { mutationsEnabled?: boolean; failCommand?: boolean } = {}): {
  services: PluginCenterServices
  commands: CommandSpec[]
} {
  const root = mkdtempSync(join(tmpdir(), 'pc-api-'))
  const seedPath = join(root, 'seed.json')
  writeFileSync(
    seedPath,
    JSON.stringify({
      version: 1,
      fetchedAt: '',
      entries: [entry('owner/alpha', COMMIT_A), entry('owner/beta', COMMIT_B)],
    }),
    'utf8',
  )
  const real = nodePorts()
  const commands: CommandSpec[] = []
  const ports: EnginePorts = {
    fs: real.fs,
    clock: real.clock,
    http: real.http,
    commands: {
      async run(spec) {
        commands.push(spec)
        if (options.failCommand) return { code: 1, stdout: '', stderr: 'nope' }
        writeFileSync(join(root, 'profile', 'package.json'), '{"touched":true}\n', 'utf8')
        return { code: 0, stdout: 'ok', stderr: '' }
      },
    },
  }
  const profileDir = join(root, 'profile')
  real.fs.mkdirDeep(profileDir)
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
    writeFileSync(join(profileDir, name), 'orig\n', 'utf8')
  }
  const services = new PluginCenterServices(
    {
      defaultProfile: 'web',
      profileDir,
      dataRoot: join(root, 'data'),
      catalogSeedPath: seedPath,
      remoteCatalogUrl: null,
      mutationsEnabled: options.mutationsEnabled ?? true,
    },
    ports,
  )
  return { services, commands }
}

describe('plugin center HTTP surface', () => {
  it('serves a bounded market page from the seed catalog', async () => {
    const { services } = makeServices()
    const response = await handleApiRequest(services, {
      method: 'GET',
      path: ROUTES.market,
      query: { page: '1', pageSize: '24' },
      headers: { host: '127.0.0.1:3080' },
    })
    expect(response.status).toBe(200)
    const payload = response.payload as { items: Array<{ id: string }>; total: number; mode: string }
    expect(payload.total).toBe(2)
    expect(payload.mode).toBe('seed')
    expect(payload.items[0]?.id).toBe('owner/beta') // exact compat sorts first
  })

  it('returns single entries by id and 4xx for unknown ids', async () => {
    const { services } = makeServices()
    const ok = await handleApiRequest(services, {
      method: 'GET',
      path: ROUTES.entry,
      query: { id: 'owner/alpha' },
      headers: { host: '127.0.0.1' },
    })
    expect(ok.status).toBe(200)
    const bad = await handleApiRequest(services, {
      method: 'GET',
      path: ROUTES.entry,
      query: { id: 'owner/missing' },
      headers: { host: '127.0.0.1' },
    })
    expect(bad.status).toBe(400) // unknown id is a client error (invalid_plan)
  })

  it('rejects mutations without the intent header or in read-only mode', async () => {
    const { services } = makeServices()
    const noIntent = await handleApiRequest(services, {
      method: 'POST',
      path: ROUTES.stagePlan,
      headers: { host: '127.0.0.1' },
      body: { action: 'install', entryId: 'owner/alpha' },
    })
    expect(noIntent.status).toBe(403)

    const readOnly = makeServices({ mutationsEnabled: false }).services
    const denied = await handleApiRequest(readOnly, {
      method: 'POST',
      path: ROUTES.stagePlan,
      headers: { host: '127.0.0.1', [INTENT_HEADER]: INTENT_HEADER && 'zdsh-plugin-center' },
      body: { action: 'install', entryId: 'owner/alpha' },
    })
    expect(denied.status).toBe(403)
  })

  it('runs the full stage→apply round trip with phrase confirmation', async () => {
    const { services, commands } = makeServices()
    const staged = await handleApiRequest(services, {
      method: 'POST',
      path: ROUTES.stagePlan,
      headers: { host: '127.0.0.1', origin: 'http://127.0.0.1', [INTENT_HEADER]: 'zdsh-plugin-center' },
      body: { action: 'install', entryId: 'owner/alpha' },
    })
    expect(staged.status).toBe(200)
    const { planId, phrase } = staged.payload as { planId: string; phrase: string }
    expect(planId).toContain('-install')

    // wrong phrase is refused without consuming
    const wrong = await handleApiRequest(services, {
      method: 'POST',
      path: ROUTES.applyPlan,
      headers: { host: '127.0.0.1', [INTENT_HEADER]: 'zdsh-plugin-center' },
      body: { planId, phrase: `${phrase}x` },
    })
    expect(wrong.status).toBe(400)

    const applied = await handleApiRequest(services, {
      method: 'POST',
      path: ROUTES.applyPlan,
      headers: { host: '127.0.0.1', [INTENT_HEADER]: 'zdsh-plugin-center' },
      body: { planId, phrase },
    })
    expect(applied.status).toBe(200)
    expect((applied.payload as { state: string }).state).toBe('restart-pending')
    expect(commands).toHaveLength(1)
    expect((commands[0] as CommandSpec).args.at(-1)).toBe(`git+https://github.com/owner/alpha.git#${COMMIT_A}`)
  })

  it('exposes runtime identity and 404s unknown routes', async () => {
    const { services } = makeServices()
    const runtime = await handleApiRequest(services, {
      method: 'GET',
      path: ROUTES.runtime,
      headers: { host: '127.0.0.1' },
    })
    expect(runtime.status).toBe(200)
    expect((runtime.payload as { bootId: string }).bootId).toMatch(/[0-9a-f-]{36}/)

    const missing = await handleApiRequest(services, {
      method: 'GET',
      path: '/api2/zdsh-plugin-center/nope',
      headers: { host: '127.0.0.1' },
    })
    expect(missing.status).toBe(404)
  })
})
