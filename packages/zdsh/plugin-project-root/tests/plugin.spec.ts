/**
 * ProjectPluginLayer + mountProjectPlugins suite (S-43 M2a):
 * serial mounting, origin, tool attribution, RunGuard watchers (B-08),
 * mount isolation (B-07), TOCTOU re-verification (B-10), and the switch
 * short-circuit (A-01/A-02).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { createProjectPluginLayer } from '../src/plugin.ts'
import { gate } from '../src/gate.ts'
import { discoverProjectPlugins } from '../src/discover.ts'
import { loadProjectTrusts, saveProjectTrusts, trustProjectRoot, decideProjectPlugin } from '../src/ledger.ts'
import { manifestBlob, writePluginPackage, tempDir, ProjectFixtureService } from './fixtures.ts'

// --- discovery spy for the switch short-circuit assertions (A-01/A-02) ---
const { discoverSpy } = vi.hoisted(() => ({ discoverSpy: vi.fn() }))

vi.mock('@deepseek-ai/dsh-plugin-project-root/src/discover.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-plugin-project-root/src/discover.ts')>()
  discoverSpy.mockImplementation(actual.discoverProjectPlugins)
  return { ...actual, discoverProjectPlugins: discoverSpy }
})

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  discoverSpy.mockClear()
})

function makeRoot(): string {
  const root = tempDir()
  roots.push(root)
  return root
}

/** A context with a Loader whose internal importer serves `modules` by specifier. */
async function mountCtx(modules: Map<string, unknown>): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  await ctx.plugin(Loader)
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const mod = modules.get(specifier)
      if (mod === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return mod
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  return ctx
}

/** Discover + gate a fixture root, returning { accepted, report }. */
async function gateFixture(root: string): Promise<Awaited<ReturnType<typeof gate>>> {
  const discovered = discoverProjectPlugins(root)
  return gate(discovered)
}

describe('ProjectPluginLayer.mount', () => {
  it('mounts entries serially with file URL specifiers, records origin, and attributes tools', async () => {
    const root = makeRoot()
    const pluginDir = writePluginPackage(root, 'demo', manifestBlob())
    // A Cordis plugin that registers a tool during apply.
    const entryModule = Object.assign(
      (
        inner: {
          tools: {
            register: (tool: {
              name: string
              description: string
              parameters: unknown
              output: unknown
              execute: () => Promise<string>
            }) => void
          }
        },
      ) => {
        inner.tools.register({
          name: 'project_tool',
          description: 'from project plugin',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
          execute: async () => 'ran',
        })
      },
      { inject: ['tools'] },
    )
    const ctx = await mountCtx(new Map([[pathToFileURL(join(pluginDir, 'index.js')).href, { default: entryModule }]]))
    // The tools service must be present for the diff-based attribution.
    const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
    const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)

    const { accepted } = await gateFixture(root)
    expect(accepted).toHaveLength(1)
    const layer = createProjectPluginLayer(ctx)
    const { mounted, report } = await layer.mount(accepted)

    expect(mounted).toHaveLength(1)
    const entryId = mounted[0] as string
    expect(entryId).toMatch(/^project-plugin-[0-9a-f]{8}-fixtures-demo$/)
    expect(report.some(row => row.verdict === 'mounted' && row.check === 'mount')).toBe(true)

    // The loader entry carries the file:// module specifier (reviewer note 1).
    const entry = [...ctx.loader.entries()].find(e => e.options.id === entryId)
    expect(entry?.options.name).toBe(pathToFileURL(join(pluginDir, 'index.js')).href)

    // Origin is keyed by the loader entry id.
    const origin = layer.originOf(entryId)
    expect(origin?.manifestId).toBe('fixtures/demo')
    expect(origin?.projectRoot).toBe(root)
    expect(origin?.clampedSandbox.network.access).toBe('none')
    expect(origin?.guardVerdict).toBe('allowed')
    expect(layer.guardedManifestOf(entryId)?.id).toBe('fixtures/demo')

    // The tool introduced by the plugin is attributed to it (snapshot diff).
    expect(layer.toolOwnerOf('project_tool')).toBe('fixtures/demo')
    expect(layer.toolOwnerOf('unrelated_tool')).toBeUndefined()

    // A RunGuard watcher was registered for the plugin.
    expect(layer.runGuard.getActiveWatchers()).toContain('fixtures/demo')
  })

  it('isolates a failing entry: mount-failed row, no throw, others still mount (B-07)', async () => {
    const root = makeRoot()
    const badDir = writePluginPackage(root, 'bad', manifestBlob({ id: 'fixtures/bad' }), '')
    const goodDir = writePluginPackage(root, 'good', manifestBlob({ id: 'fixtures/good' }))
    const ctx = await mountCtx(new Map([
      [pathToFileURL(join(badDir, 'index.js')).href, { default: Object.assign(() => { throw new Error('init exploded') }, { inject: [] }) }],
      [pathToFileURL(join(goodDir, 'index.js')).href, { default: ProjectFixtureService }],
    ]))

    const { accepted } = await gateFixture(root)
    expect(accepted).toHaveLength(2)
    const layer = createProjectPluginLayer(ctx)
    await expect(layer.mount(accepted)).resolves.toBeDefined()

    const report = layer.report
    expect(report.some(row => row.id === 'fixtures/bad' && row.verdict === 'mount-failed' && row.check === 'mount')).toBe(true)
    expect(report.some(row => row.id === 'fixtures/good' && row.verdict === 'mounted')).toBe(true)
    // Only the good entry is present in the loader tree.
    const entries = [...ctx.loader.entries()]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.options.id).toMatch(/fixtures-good$/)
  })

  it('refuses to mount when the disk content changed since discovery (B-10)', async () => {
    const root = makeRoot()
    const pluginDir = writePluginPackage(root, 'demo', manifestBlob())
    const ctx = await mountCtx(new Map([[pathToFileURL(join(pluginDir, 'index.js')).href, { default: ProjectFixtureService }]]))

    const { accepted } = await gateFixture(root)
    // Tamper with the manifest AFTER discovery captured the hash.
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifestBlob({ version: '9.9.9' })))

    const layer = createProjectPluginLayer(ctx)
    const { mounted, report } = await layer.mount(accepted)
    expect(mounted).toEqual([])
    expect(report.some(row => row.verdict === 'mount-failed' && row.check === 'toctou')).toBe(true)
    expect([...ctx.loader.entries()]).toHaveLength(0)
  })

  it('enforces the call count limit on the production path (B-08)', async () => {
    // The watcher's explicit default maxCallCount (100) is armed for the
    // CLAMPED manifest (timeoutMs ≤ 60000 after the host clamp), so the count
    // limit is reachable through the real mount → watch → wrapper pipeline.
    const root = makeRoot()
    const pluginDir = writePluginPackage(root, 'demo', manifestBlob())
    const entryModule = Object.assign(
      (
        inner: {
          tools: {
            register: (tool: {
              name: string
              description: string
              parameters: unknown
              output: unknown
              execute: () => Promise<string>
            }) => void
          }
        },
      ) => {
        inner.tools.register({
          name: 'project_counted_tool',
          description: 'counted project tool',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
          execute: async () => 'ran',
        })
      },
      { inject: ['tools'] },
    )
    const ctx = await mountCtx(new Map([[pathToFileURL(join(pluginDir, 'index.js')).href, { default: entryModule }]]))
    const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
    const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)

    const { accepted } = await gateFixture(root)
    // The clamped sandbox keeps timeoutMs ≤ 60000 (the clamp caps it), which
    // previously made maxCallCount unreachable; the M2b default arms it.
    expect(accepted[0]?.clampedSandbox.resources.timeoutMs).toBeLessThanOrEqual(60000)
    const layer = createProjectPluginLayer(ctx)
    const { mounted } = await layer.mount(accepted)
    expect(mounted).toHaveLength(1)
    expect(layer.runGuard.getWatcher('fixtures/demo')?.getHealthStatus().callCount).toBe(0)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'c1' as import('@deepseek-ai/dsh-llm').ToolCallId,
      name: 'project_counted_tool',
      arguments: {},
    })
    expect(result.isError).toBe(false)

    // Exceed the 100-call budget: the 101st call returns a governance error.
    for (let i = 0; i < 99; i += 1) {
      const r = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `c${i}` as import('@deepseek-ai/dsh-llm').ToolCallId,
        name: 'project_counted_tool',
        arguments: {},
      })
      expect(r.isError, `call ${i + 1}`).toBe(false)
    }
    const refused = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'c101' as import('@deepseek-ai/dsh-llm').ToolCallId,
      name: 'project_counted_tool',
      arguments: {},
    })
    expect(refused.isError).toBe(true)
    if (refused.isError) {
      expect(refused.error.info?.code).toBe('PLUGIN_GOVERNANCE')
      expect(refused.error.message).toContain('Exceeded maximum call count')
    }
  })

  it('is idempotent about its service surface and disposes cleanly', async () => {
    const root = makeRoot()
    const pluginDir = writePluginPackage(root, 'demo', manifestBlob())
    const ctx = await mountCtx(new Map([[pathToFileURL(join(pluginDir, 'index.js')).href, { default: ProjectFixtureService }]]))
    const { accepted } = await gateFixture(root)

    const layer = createProjectPluginLayer(ctx)
    const provided = (ctx as Context & { projectPluginLayer?: unknown }).projectPluginLayer
    expect(provided).toBe(layer)
    await layer.mount(accepted)
    layer.dispose()
    // The service is un-provided and the watchers are dropped.
    expect((ctx as Context & { projectPluginLayer?: unknown }).projectPluginLayer).toBeUndefined()
    expect(layer.runGuard.getActiveWatchers()).toEqual([])
  })
})

describe('mountProjectPlugins switch short-circuit (A-01/A-02)', () => {
  it('performs zero discovery and mounts nothing when the switch is off (A-02)', async () => {
    const root = makeRoot()
    mkdirSync(join(root, '.git'))
    writePluginPackage(root, 'demo', manifestBlob())
    const ctx = await mountCtx(new Map())
    const { mountProjectPlugins } = await import('../src/plugin.ts')
    const result = await mountProjectPlugins(ctx, new Map(), { cwd: join(root, 'src') })
    expect(discoverSpy).not.toHaveBeenCalled()
    expect(result.layer).toBeUndefined()
    expect(result.report).toEqual([])
    expect(result.mounted).toEqual([])
    expect([...ctx.loader.entries()]).toHaveLength(0)
  })

  it('keeps the boot composition untouched: no rows, no loader entries (A-01)', async () => {
    const root = makeRoot()
    writePluginPackage(root, 'demo', manifestBlob())
    const ctx = await mountCtx(new Map())
    const { mountProjectPlugins } = await import('../src/plugin.ts')
    // A composed profile WITHOUT the switch row: identical boot behavior.
    const rows = new Map<string, EntryOptions>([
      ['agent-presets', { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: {} }],
    ])
    const result = await mountProjectPlugins(ctx, rows, { cwd: root })
    expect(result.layer).toBeUndefined()
    expect(discoverSpy).not.toHaveBeenCalled()
    expect([...ctx.loader.entries()]).toHaveLength(0)
  })

  it('discovers and gates when the switch is on, leaving untrusted roots pending (C-02)', async () => {
    const root = makeRoot()
    mkdirSync(join(root, '.git'))
    writePluginPackage(root, 'demo', manifestBlob())
    const ctx = await mountCtx(new Map())
    const { mountProjectPlugins } = await import('../src/plugin.ts')
    const dataDir = tempDir()
    roots.push(dataDir)
    const rows = new Map<string, EntryOptions>([
      ['project-plugins', { id: 'project-plugins', name: 'project-plugins', config: { enabled: true } }],
    ])
    const result = await mountProjectPlugins(ctx, rows, { cwd: root, dataDir })
    expect(discoverSpy).toHaveBeenCalledTimes(1)
    // No trust recorded: the plugin stays pending-trust and nothing mounts.
    expect(result.layer).toBeDefined()
    expect(result.mounted).toEqual([])
    expect(result.report.some(row => row.verdict === 'rejected' && row.check === 'pending-trust')).toBe(true)
    expect([...ctx.loader.entries()]).toHaveLength(0)
  })

  it('mounts trusted enabled plugins and skips ledger-disabled ones (C-02)', async () => {
    const root = makeRoot()
    mkdirSync(join(root, '.git'))
    writePluginPackage(root, 'demo', manifestBlob())
    writePluginPackage(root, 'other', manifestBlob({ id: 'fixtures/other', name: 'Other' }))
    const pluginDir = join(root, '.dsh', 'plugins', 'demo')
    const ctx = await mountCtx(new Map([
      [pathToFileURL(join(pluginDir, 'index.js')).href, { default: ProjectFixtureService }],
    ]))
    const { mountProjectPlugins } = await import('../src/plugin.ts')
    const dataDir = tempDir()
    roots.push(dataDir)
    const trusts = loadProjectTrusts(dataDir)
    trustProjectRoot(trusts, root)
    decideProjectPlugin(trusts, root, 'fixtures/demo', true)
    decideProjectPlugin(trusts, root, 'fixtures/other', false)
    saveProjectTrusts(dataDir, trusts)

    const rows = new Map<string, EntryOptions>([
      ['project-plugins', { id: 'project-plugins', name: 'project-plugins', config: { enabled: true } }],
    ])
    const result = await mountProjectPlugins(ctx, rows, { cwd: root, dataDir })
    // demo is trusted+enabled and mounts; other is ledger-disabled and skipped.
    expect(result.mounted).toHaveLength(1)
    expect(result.report.some(row => row.id === 'fixtures/other' && row.check === 'ledger-disabled')).toBe(true)
    expect(result.layer?.originOf(result.mounted[0] as string)?.manifestId).toBe('fixtures/demo')
  })
})
