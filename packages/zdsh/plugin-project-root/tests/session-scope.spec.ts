/**
 * Session-scope enforcement suite (S-43 M3, C-03): cwd-path matching,
 * per-agent restriction via wireSessionScope, and the execute-time defense
 * check in the project tool wrapper.
 *
 * The cwdHitsProjectRoot predicate is tested directly. The wireSessionScope
 * wiring is tested with a fake agents service (structural access — no
 * @deepseek-ai/dsh-agent import). The execute-time defense is tested through
 * the projectToolWrapper with a shaped exec.agent fake.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { RunGuard, type PluginManifest } from '@deepseek-ai/dsh-plugin-governance'
import { cwdHitsProjectRoot, wireSessionScope, type SessionAgentsServiceLike, type SessionAgentLike } from '../src/session-scope.ts'
import { projectToolWrapper } from '../src/tool-guard.ts'
import { createProjectPluginLayer } from '../src/plugin.ts'
import { gate } from '../src/gate.ts'
import { discoverProjectPlugins } from '../src/discover.ts'
import { manifestBlob, testManifest, testSandbox } from './fixtures.ts'

const cleanupRoots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ppr-scope-'))
  cleanupRoots.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// cwdHitsProjectRoot unit tests
// ---------------------------------------------------------------------------

describe('cwdHitsProjectRoot', () => {
  const PROJECT = process.platform === 'win32' ? 'C:\\Users\\test\\project' : '/home/user/project'

  it('returns true when cwd equals the project root', () => {
    expect(cwdHitsProjectRoot(PROJECT, PROJECT)).toBe(true)
  })

  it('returns true when cwd is a subdirectory of the project root', () => {
    expect(cwdHitsProjectRoot(`${PROJECT}/src`, PROJECT)).toBe(true)
    expect(cwdHitsProjectRoot(`${PROJECT}/sub/deep`, PROJECT)).toBe(true)
  })

  it('returns false when cwd is outside the project root', () => {
    expect(cwdHitsProjectRoot(`${PROJECT}-sibling`, PROJECT)).toBe(false)
    expect(cwdHitsProjectRoot('/other/project', PROJECT)).toBe(false)
  })

  it('returns false when cwd is undefined or empty', () => {
    expect(cwdHitsProjectRoot(undefined, PROJECT)).toBe(false)
    expect(cwdHitsProjectRoot('', PROJECT)).toBe(false)
    expect(cwdHitsProjectRoot('   ', PROJECT)).toBe(false)
  })

  it('handles case folding per platform (win32 folds, posix does not)', () => {
    const root = 'C:\\Users\\Test\\Project'
    const cwd = 'c:\\users\\test\\project\\src'
    if (process.platform === 'win32') {
      // win32 filesystems are case-insensitive: keyOf folds both sides to
      // lowercase, so the mixed-case cwd still prefix-matches the root.
      expect(cwdHitsProjectRoot(cwd, root)).toBe(true)
    } else {
      // posix filesystems are case-sensitive and keyOf deliberately does NOT
      // fold case there: both drive-letter literals resolve (cwd-relative) to
      // distinct names that differ from the first character, so no match.
      // Asserting the denial keeps the case-sensitivity contract covered.
      expect(cwdHitsProjectRoot(cwd, root)).toBe(false)
    }
  })

  it('handles prefix collision: /work vs /workshop', () => {
    expect(cwdHitsProjectRoot('/workshop/src', '/work')).toBe(false)
  })

  it('handles drive root per platform (win32 drive semantics, posix anchored literals)', () => {
    const root = 'C:\\'
    const cwd = 'C:\\Users\\test'
    if (process.platform === 'win32') {
      // win32: resolve('C:\') is the drive root; the trailing-separator strip
      // leaves 'c:', so every path on that drive prefix-matches through the
      // '\' branch — the original drive-root semantics this test was named for.
      expect(cwdHitsProjectRoot(cwd, root)).toBe(true)
    } else {
      // posix has no drive letters and '\' is an ordinary filename character,
      // so both literals are RELATIVE single-segment names that resolve()
      // deterministically anchors under the same process cwd: root '<cwd>/C:\'
      // strips to '<cwd>/C:' and cwd '<cwd>/C:\Users\test' then matches the
      // '\' prefix branch (which exists for win32 drive roots). Pin that
      // anchoring mechanism alongside the outcome so the green is asserted
      // behavior, not an accident of resolve(); it deliberately claims NO
      // drive-root semantics on posix — those are the win32 branch above.
      expect(resolve(cwd).startsWith(resolve(root))).toBe(true)
      expect(cwdHitsProjectRoot(cwd, root)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// wireSessionScope with a fake agents service
// ---------------------------------------------------------------------------

describe('wireSessionScope', () => {
  /** A fake agent shape: session cwd + ctx.tools.restrict spy. */
  function fakeAgent(
    cwd: string | undefined,
    restrict?: ReturnType<typeof vi.fn>,
    ctx?: { tools?: { restrict?: ReturnType<typeof vi.fn> } },
  ) {
    const restrictFn = restrict ?? vi.fn()
    return {
      session: { header: { cwd } },
      ctx: ctx ?? { tools: { restrict: restrictFn } },
    }
  }

  function fakeAgentsService(agents: ReturnType<typeof fakeAgent>[]) {
    const listeners: Array<(payload: { agent: ReturnType<typeof fakeAgent> }) => void> = []
    return {
      list: () => agents,
      on: (event: string, listener: (payload: { agent: ReturnType<typeof fakeAgent> }) => void) => {
        if (event === 'agent/created') {
          listeners.push(listener)
          return () => { listeners.splice(listeners.indexOf(listener), 1) }
        }
        return () => {}
      },
      // Expose for test assertions.
      _listeners: listeners,
      _emitCreated: (agent: ReturnType<typeof fakeAgent>) => {
        for (const listener of listeners) listener({ agent })
      },
    }
  }

  it('applies no restrictions for an agent whose cwd matches the project root', () => {
    const restrict = vi.fn()
    const agent = fakeAgent('/home/user/project', restrict)
    const agents = fakeAgentsService([agent])
    const wiring = wireSessionScope({ agents }, vi.fn())
    wiring.applyRestrictions(['tool_a', 'tool_b'], '/home/user/project')
    expect(restrict).not.toHaveBeenCalled()
    wiring.dispose()
  })

  it('restricts tools for an agent whose cwd misses the project root', () => {
    const restrict = vi.fn()
    const agent = fakeAgent('/other/project', restrict)
    const agents = fakeAgentsService([agent])
    const wiring = wireSessionScope({ agents }, vi.fn())
    wiring.applyRestrictions(['tool_a', 'tool_b'], '/home/user/project')
    // Every tool that belongs to the me project is restricted for this agent.
    expect(restrict).toHaveBeenCalledTimes(2)
    expect(restrict).toHaveBeenCalledWith({ deny: ['tool_a'] })
    expect(restrict).toHaveBeenCalledWith({ deny: ['tool_b'] })
    wiring.dispose()
  })

  it('sweeps live agents and also catches new ones via agent/created', () => {
    const restrict1 = vi.fn()
    const agent1 = fakeAgent('/other/path', restrict1)
    const agents = fakeAgentsService([agent1])
    const wiring = wireSessionScope({ agents }, vi.fn())

    // Apply restrictions for a root: agent1 gets restricted.
    wiring.applyRestrictions(['tool_a'], '/home/user/project')
    expect(restrict1).toHaveBeenCalledTimes(1)

    // A new agent is created after the sweep: the listener restricts it too.
    const restrict2 = vi.fn()
    const agent2 = fakeAgent('/yet/another', restrict2)
    agents._emitCreated(agent2)
    expect(restrict2).toHaveBeenCalledTimes(1)
    expect(restrict2).toHaveBeenCalledWith({ deny: ['tool_a'] })

    wiring.dispose()
  })

  it('re-sweeps agents when a later mount adds new tool names (no stale gap)', () => {
    const restrict = vi.fn()
    const agent = fakeAgent('/other/path', restrict)
    const agents = fakeAgentsService([agent])
    const wiring = wireSessionScope({ agents }, vi.fn())
    wiring.applyRestrictions(['tool_a'], '/home/user/project')
    expect(restrict).toHaveBeenCalledTimes(1)
    // A second plugin mounts with a new tool: the agent is re-swept and the
    // NEW name is restricted too, while tool_a is not denied a second time.
    wiring.applyRestrictions(['tool_b'], '/home/user/project')
    expect(restrict).toHaveBeenCalledTimes(2)
    expect(restrict).toHaveBeenCalledWith({ deny: ['tool_b'] })
    wiring.dispose()
  })

  it('dispose removes the agent/created listener', () => {
    const restrict = vi.fn()
    const agents = fakeAgentsService([])
    const wiring = wireSessionScope({ agents }, vi.fn())
    wiring.dispose()
    const agent = fakeAgent('/other/path', restrict)
    agents._emitCreated(agent)
    // After dispose, the listener is removed, so no restriction is applied.
    expect(restrict).not.toHaveBeenCalled()
  })

  it('is inert when the context carries no agents service', () => {
    const wiring = wireSessionScope({}, vi.fn())
    // Should not throw.
    wiring.applyRestrictions(['tool_a'], '/root')
    wiring.dispose()
  })
})

// ---------------------------------------------------------------------------
// Execute-time defense check (C-03 execution denial)
// ---------------------------------------------------------------------------

describe('projectToolWrapper session-scope defense (C-03)', () => {
  async function mount(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    return ctx
  }

  /** A manifest with the default sandbox for the RunGuard watcher. */
  function countedManifest(): PluginManifest {
    return testManifest({
      sandbox: testSandbox({
        resources: { memoryLimitMb: 128, cpuLimit: 50, timeoutMs: 30000, maxOutputBytes: 10000 },
      }),
    })
  }

  it('denies a project tool call from an agent whose session cwd misses the project root', async () => {
    const ctx = await mount()
    const runGuard = new RunGuard()
    runGuard.watch('fixtures/demo', { manifest: countedManifest(), install: () => {} })
    const toolOwners = new Map([['demo_tool', 'fixtures/demo']])
    const pluginRoots = new Map([['fixtures/demo', '/home/user/project']])
    const dispose = projectToolWrapper(ctx, {
      toolOwnerOf: name => toolOwners.get(name),
      projectRootOf: pluginId => pluginRoots.get(pluginId),
      runGuard,
    })
    try {
      ctx.tools.register({
        name: 'demo_tool',
        description: 'demo',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
        execute: async () => 'ran',
      })
      // Call with an agent whose cwd misses the project root.
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'c1' as ToolCallId,
        name: 'demo_tool',
        arguments: {},
        agent: { session: { header: { cwd: '/other/project' } } } as never,
      })
      expect(result.isError).toBe(true)
      if (result.isError) {
        expect(result.error.info?.code).toBe('PROJECT_SCOPE')
      }
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('allows a project tool call from an agent whose session cwd hits the project root', async () => {
    const ctx = await mount()
    const runGuard = new RunGuard()
    runGuard.watch('fixtures/demo', { manifest: countedManifest(), install: () => {} })
    const toolOwners = new Map([['demo_tool', 'fixtures/demo']])
    const pluginRoots = new Map([['fixtures/demo', '/home/user/project']])
    const dispose = projectToolWrapper(ctx, {
      toolOwnerOf: name => toolOwners.get(name),
      projectRootOf: pluginId => pluginRoots.get(pluginId),
      runGuard,
    })
    try {
      ctx.tools.register({
        name: 'demo_tool',
        description: 'demo',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
        execute: async () => 'ran',
      })
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'c1' as ToolCallId,
        name: 'demo_tool',
        arguments: {},
        agent: { session: { header: { cwd: '/home/user/project/src' } } } as never,
      })
      expect(result.isError).toBe(false)
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('allows a project tool call with no agent (no session to scope against)', async () => {
    const ctx = await mount()
    const runGuard = new RunGuard()
    runGuard.watch('fixtures/demo', { manifest: countedManifest(), install: () => {} })
    const toolOwners = new Map([['demo_tool', 'fixtures/demo']])
    const pluginRoots = new Map([['fixtures/demo', '/home/user/project']])
    const dispose = projectToolWrapper(ctx, {
      toolOwnerOf: name => toolOwners.get(name),
      projectRootOf: pluginId => pluginRoots.get(pluginId),
      runGuard,
    })
    try {
      ctx.tools.register({
        name: 'demo_tool',
        description: 'demo',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
        execute: async () => 'ran',
      })
      // No agent field: the execute-time check allows it (no session to scope).
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'c1' as ToolCallId,
        name: 'demo_tool',
        arguments: {},
      })
      expect(result.isError).toBe(false)
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('passes non-project tools through unchanged (D-01 regression)', async () => {
    const ctx = await mount()
    const runGuard = new RunGuard()
    const dispose = projectToolWrapper(ctx, {
      toolOwnerOf: () => undefined,
      projectRootOf: () => undefined,
      runGuard,
    })
    try {
      ctx.tools.register({
        name: 'host_tool',
        description: 'host',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
        execute: async () => 'ok',
      })
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'c1' as ToolCallId,
        name: 'host_tool',
        arguments: {},
      })
      expect(result.isError).toBe(false)
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end C-03: mount a project plugin and assert per-session visibility
// ---------------------------------------------------------------------------

describe('ProjectPluginLayer session-scope integration (C-03)', () => {
  /** Fake agents service + fake agents with restrict spies, provided as ctx.agents. */
  function fakeAgentsService(root: string) {
    const restrictCalls: Array<{ agent: string; tool: string }> = []
    const agentOf = (id: string, cwd: string): SessionAgentLike => ({
      session: { header: { cwd } },
      ctx: {
        tools: {
          restrict: (filter: { deny: readonly string[] }) => {
            for (const tool of filter.deny) restrictCalls.push({ agent: id, tool })
            return () => {}
          },
        },
      },
    })
    // 'matching' lives inside the root; 'outside' is a sibling directory.
    const live = [agentOf('matching', join(root, 'src')), agentOf('outside', join(root, '..', 'other'))]
    const service: SessionAgentsServiceLike & { list: () => typeof live; on: () => () => void } = {
      list: () => live,
      on: () => () => {},
    }
    return { service, restrictCalls, live }
  }

  it('restricts mounted project tools only for agents whose cwd misses the root', async () => {
    const root = tempDir()
    const pluginDir = join(root, '.dsh', 'plugins', 'demo')
    const entryFile = join(pluginDir, 'index.js')
    const module: Record<string, unknown> = {
      default: Object.assign(
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
            output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
            execute: async () => 'ran',
          })
        },
        { inject: ['tools'] },
      ),
    }
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifestBlob(), null, 2))
    writeFileSync(entryFile, 'export default class {}')

    const ctx = new Context()
    contexts.push(ctx)
    const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
    await ctx.plugin(Loader)
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== pathToFileURL(entryFile).href) throw new Error(`unexpected import ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)

    // Provide a fake agents service (two live sessions: one inside the root,
    // one outside) exactly like the real AgentRegistry provides ctx.agents.
    const { service, restrictCalls } = fakeAgentsService(root)
    ctx.reflect.provide('agents', service)

    const { accepted } = await gate(discoverProjectPlugins(root))
    expect(accepted).toHaveLength(1)
    const layer = createProjectPluginLayer(ctx)
    const { mounted } = await layer.mount(accepted)
    expect(mounted).toHaveLength(1)

    // The outside agent got the tool restricted; the matching agent did not.
    expect(restrictCalls).toEqual([{ agent: 'outside', tool: 'project_tool' }])
    // The layer resolves the owning root for the execute-time defense.
    expect(layer.projectRootOf('fixtures/demo')).toBe(root)
    expect(layer.projectRootOf('fixtures/unknown')).toBeUndefined()
  })
})
