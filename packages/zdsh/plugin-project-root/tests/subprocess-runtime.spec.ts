/**
 * Subprocess runtime suite (S-43 M2b): the B-06 sync while(true) variants —
 * a hung execution body is reclaimed in process/worker tier while the host
 * (core) keeps running — plus the B-09 environment leak probe and the IPC
 * whitelist gate.
 *
 * These tests spawn REAL child processes / worker threads; each test carries
 * an explicit generous timeout and cleans up its layer (dispose stops every
 * subprocess).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createProjectPluginLayer } from '../src/plugin.ts'
import { gate } from '../src/gate.ts'
import { discoverProjectPlugins } from '../src/discover.ts'
import { createSubprocessRuntime, SubprocessTimeoutError, SubprocessToolError } from '../src/subprocess-runtime.ts'
import { tempDir, testSandbox } from './fixtures.ts'

const signal = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeRoot(): string {
  const root = tempDir()
  roots.push(root)
  return root
}

/** A host tool used to prove the core survives a subprocess reclaim. */
function hostTool(name: string): ToolDefinition {
  return {
    name,
    description: `host tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    execute: async () => 'host-ok',
  }
}

/** Write a plugin package with a raw entry file (CJS) under a temp root. */
function writeSubprocessPackage(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  entryJs: string,
): string {
  const pluginDir = join(root, '.dsh', 'plugins', name)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(pluginDir, 'index.js'), entryJs)
  return pluginDir
}

/** The CJS entry module for a plugin with a hang tool and an echo tool. */
const hangEchoEntry = `module.exports = Object.assign(
  (inner) => {
    inner.tools.register({
      name: 'hang_tool',
      description: 'hangs forever',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => { while (true) {} },
    })
    inner.tools.register({
      name: 'echo_tool',
      description: 'echoes',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => 'echo-ok',
    })
  },
  { inject: ['tools'] },
)
`

/** A manifest declaring a subprocess sandbox with a short timeout. */
function subprocessManifest(type: 'process' | 'worker', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixtures/hang',
    version: '1.0.0',
    name: 'Hang Plugin',
    dsh: { compatible: '>=0.1.0-rc.8' },
    capabilities: [
      { type: 'tool', tool: { name: 'hang_tool', description: 'hangs forever', schema: { type: 'object' } } },
      { type: 'tool', tool: { name: 'echo_tool', description: 'echoes', schema: { type: 'object' } } },
    ],
    sandbox: {
      type,
      resources: { memoryLimitMb: 256, cpuLimit: 50, timeoutMs: 300, maxOutputBytes: 10000 },
      filesystem: { access: 'readonly', allowedPaths: [], deniedPatterns: [] },
      network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: false },
      environment: { whitelist: [], blacklist: [], clear: false },
      process: { spawn: false, exec: false, allowedCommands: [] },
    },
    ...overrides,
  }
}

/** Mount the tools runtime on a fresh context. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  return ctx
}

async function run(ctx: Context, name: string, args: Record<string, unknown> = {}): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal, callId: 'c1' as ToolCallId, name, arguments: args })
}

describe('subprocess runtime (M2b)', () => {
  it('mounts a process-tier plugin in a subprocess and exposes proxy tools', async () => {
    const root = makeRoot()
    writeSubprocessPackage(root, 'hang', subprocessManifest('process'), hangEchoEntry)
    const ctx = await mount()
    ctx.tools.register(hostTool('host_probe'))

    const { accepted } = await gate(discoverProjectPlugins(root))
    expect(accepted).toHaveLength(1)
    expect(accepted[0]?.clampedSandbox.type).toBe('process')

    const layer = createProjectPluginLayer(ctx)
    const { mounted, report } = await layer.mount(accepted)
    expect(report.some(row => row.verdict === 'mounted')).toBe(true)
    expect(mounted).toHaveLength(1)
    const entryId = mounted[0] as string

    // Origin carries the M2b subprocess tier.
    expect(layer.originOf(entryId)?.runtimeTier).toBe('subprocess')
    expect(layer.originOf(entryId)?.clampedSandbox.type).toBe('process')
    expect(layer.isSubprocess('fixtures/hang')).toBe(true)

    // The manifest-declared tools are attributed and exposed as proxies.
    expect(layer.toolOwnerOf('hang_tool')).toBe('fixtures/hang')
    expect(layer.toolOwnerOf('echo_tool')).toBe('fixtures/hang')

    // The echo tool round-trips through the subprocess.
    const echo = await run(ctx, 'echo_tool')
    expect(echo.isError).toBe(false)
    if (!echo.isError) expect(echo.value).toBe('echo-ok')

    layer.dispose()
  }, 60000)

  it('reclaims a sync while(true) execution body in process tier; core survives (B-06)', async () => {
    const root = makeRoot()
    writeSubprocessPackage(root, 'hang', subprocessManifest('process'), hangEchoEntry)
    const ctx = await mount()
    ctx.tools.register(hostTool('host_probe'))

    const { accepted } = await gate(discoverProjectPlugins(root))
    const layer = createProjectPluginLayer(ctx)
    const { mounted } = await layer.mount(accepted)
    expect(mounted).toHaveLength(1)

    // The hang tool blocks the subprocess event loop with a sync while(true).
    const hung = await run(ctx, 'hang_tool')
    expect(hung.isError).toBe(true)
    if (hung.isError) {
      expect(hung.error.info?.code).toBe('PLUGIN_TIMEOUT')
    }

    // The hung execution body is reclaimed: the subprocess is dead.
    await vi.waitFor(() => {
      expect(layer.subprocessOf('fixtures/hang')?.isRunning()).toBe(false)
    })
    // The plugin is dead: a subsequent whitelisted call reports not running.
    await expect(layer.subprocessOf('fixtures/hang')?.executeTool('echo_tool', {}))
      .rejects.toThrow(/not running/)

    // The host (core) survives and keeps serving other tools.
    const probe = await run(ctx, 'host_probe')
    expect(probe.isError).toBe(false)
    if (!probe.isError) expect(probe.value).toBe('host-ok')

    layer.dispose()
  }, 60000)

  it('reclaims a sync while(true) execution body in worker tier (B-06)', async () => {
    const root = makeRoot()
    writeSubprocessPackage(root, 'hang', subprocessManifest('worker'), hangEchoEntry)
    const ctx = await mount()
    ctx.tools.register(hostTool('host_probe'))

    const { accepted } = await gate(discoverProjectPlugins(root))
    expect(accepted[0]?.clampedSandbox.type).toBe('worker')
    const layer = createProjectPluginLayer(ctx)
    const { mounted } = await layer.mount(accepted)
    expect(mounted).toHaveLength(1)
    expect(layer.originOf(mounted[0] as string)?.runtimeTier).toBe('subprocess')

    const hung = await run(ctx, 'hang_tool')
    expect(hung.isError).toBe(true)
    if (hung.isError) {
      expect(hung.error.info?.code).toBe('PLUGIN_TIMEOUT')
    }
    await vi.waitFor(() => {
      expect(layer.subprocessOf('fixtures/hang')?.isRunning()).toBe(false)
    })

    // Core still serves the host tool.
    const probe = await run(ctx, 'host_probe')
    expect(probe.isError).toBe(false)
    layer.dispose()
  }, 60000)

  it('does not leak sensitive host environment into the subprocess (B-09)', async () => {
    const root = makeRoot()
    const envProbeEntry = `module.exports = Object.assign(
      (inner) => {
        inner.tools.register({
          name: 'env_probe',
          description: 'probes the subprocess env',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
          execute: async () => JSON.stringify({
            secret: process.env.SECRET_TOKEN ?? null,
            myVar: process.env.MY_PROBE_VAR ?? null,
            dsh: process.env.DSH_SANDBOX ?? null,
            nodeEnv: process.env.NODE_ENV ?? null,
          }),
        })
      },
      { inject: ['tools'] },
    )
`
    const manifest = subprocessManifest('process', {
      id: 'fixtures/envprobe',
      capabilities: [{ type: 'tool', tool: { name: 'env_probe', description: 'probes env', schema: { type: 'object' } } }],
      sandbox: {
        ...(subprocessManifest('process').sandbox as Record<string, unknown>),
        environment: { whitelist: ['MY_PROBE_VAR'], blacklist: [], clear: false },
      },
    })
    writeSubprocessPackage(root, 'envprobe', manifest, envProbeEntry)

    // The host carries a sensitive secret and a whitelisted business variable.
    vi.stubEnv('SECRET_TOKEN', 'top-secret-value')
    vi.stubEnv('MY_PROBE_VAR', 'whitelisted-value')
    const ctx = await mount()
    const { accepted } = await gate(discoverProjectPlugins(root))
    const layer = createProjectPluginLayer(ctx)
    const { mounted } = await layer.mount(accepted)
    expect(mounted).toHaveLength(1)

    const probe = await run(ctx, 'env_probe')
    expect(probe.isError).toBe(false)
    const value = JSON.parse(probe.value as string) as Record<string, string | null>
    // The sensitive shape never reaches the subprocess; the whitelisted var
    // does; the sandbox markers are set last (cannot be spoofed).
    expect(value.secret).toBeNull()
    expect(value.myVar).toBe('whitelisted-value')
    expect(value.dsh).toBe('true')
    expect(value.nodeEnv).toBe('production')

    layer.dispose()
  }, 60000)

  it('enforces the IPC whitelist on the host side (T3-E)', async () => {
    const root = makeRoot()
    writeSubprocessPackage(root, 'hang', subprocessManifest('process'), hangEchoEntry)
    const ctx = await mount()
    const { accepted } = await gate(discoverProjectPlugins(root))
    const layer = createProjectPluginLayer(ctx)
    const { mounted } = await layer.mount(accepted)
    expect(mounted).toHaveLength(1)

    const runtime = layer.subprocessOf('fixtures/hang')
    expect(runtime).toBeDefined()
    // Whitelisted names pass through the gate (echo works).
    await expect(runtime?.executeTool('echo_tool', {})).resolves.toMatchObject({ isError: false })
    // A name outside the manifest whitelist is refused before any IPC.
    await expect(runtime?.executeTool('rogue_tool', {})).rejects.toBeInstanceOf(SubprocessToolError)
    await expect(runtime?.executeTool('rogue_tool', {})).rejects.toThrow(/not in the IPC whitelist/)

    layer.dispose()
  }, 60000)

  it('exposes timeout and lifecycle errors through the runtime contract', async () => {
    // Direct runtime contract: a hung tool times out and the subprocess is
    // killed, surfacing SubprocessTimeoutError.
    const root = makeRoot()
    const pluginDir = writeSubprocessPackage(root, 'hang', subprocessManifest('process'), hangEchoEntry)
    const sandbox = testSandbox({
      type: 'process',
      resources: { memoryLimitMb: 256, cpuLimit: 50, timeoutMs: 200, maxOutputBytes: 10000 },
    })
    const runtime = createSubprocessRuntime({
      pluginId: 'fixtures/hang',
      type: 'process',
      entryFile: join(pluginDir, 'index.js'),
      config: sandbox,
      toolWhitelist: ['hang_tool', 'echo_tool'],
    })
    await runtime.start()
    expect(runtime.isRunning()).toBe(true)
    await expect(runtime.executeTool('hang_tool', {})).rejects.toBeInstanceOf(SubprocessTimeoutError)
    await vi.waitFor(() => { expect(runtime.isRunning()).toBe(false) })
    // The runtime rejects calls once the subprocess is gone.
    await expect(runtime.executeTool('echo_tool', {})).rejects.toThrow(/not running/)
    // stop() on a dead runtime is a no-op.
    await expect(runtime.stop()).resolves.toBeUndefined()
  }, 60000)
})
