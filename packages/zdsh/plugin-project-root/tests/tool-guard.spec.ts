/**
 * Project tool wrapper suite (S-43 M2a, B-08): every project tool call is
 * routed through the RunGuard; watcher outcomes (call-count exceeded, timeout)
 * map to structured governance error results, and non-project tools pass
 * through with zero behavior change (D-01).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { RunGuard, type PluginManifest } from '@deepseek-ai/dsh-plugin-governance'
import { projectToolWrapper } from '../src/tool-guard.ts'
import { testManifest, testSandbox } from './fixtures.ts'

const testToolSignal = new AbortController().signal

/** Mount the tool registry on a fresh context. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  return ctx
}

function tool(name: string, body: () => Promise<unknown> = async () => 'ok'): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    execute: body,
  }
}

async function run(ctx: Context, name: string): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: 'c1' as ToolCallId,
    name,
    arguments: {},
  })
}

/**
 * A manifest with the default sandbox: the watcher's explicit default
 * maxCallCount (100, fixed since M2b) applies to EVERY manifest, so the call
 * count limit is reachable on the production path (clamped timeoutMs ≤ 60000).
 */
function countedManifest(): PluginManifest {
  return testManifest({
    sandbox: testSandbox({
      resources: { memoryLimitMb: 128, cpuLimit: 50, timeoutMs: 30000, maxOutputBytes: 10000 },
    }),
  })
}

describe('projectToolWrapper (B-08)', () => {
  it('routes project tool calls through the RunGuard and counts them', async () => {
    const ctx = await mount()
    const runGuard = new RunGuard()
    runGuard.watch('fixtures/demo', { manifest: countedManifest(), install: () => {} })
    const toolOwners = new Map([['demo_tool', 'fixtures/demo']])
    const dispose = projectToolWrapper(ctx, {
      toolOwnerOf: name => toolOwners.get(name),
      projectRootOf: () => undefined,
      runGuard,
    })
    try {
      ctx.tools.register(tool('demo_tool'))
      const watcher = runGuard.getWatcher('fixtures/demo')
      expect(watcher?.getHealthStatus().callCount).toBe(0)
      const result = await run(ctx, 'demo_tool')
      expect(result.isError).toBe(false)
      expect(watcher?.getHealthStatus().callCount).toBe(1)
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('returns a governance error result when the call count is exceeded', async () => {
    const ctx = await mount()
    const runGuard = new RunGuard()
    runGuard.watch('fixtures/demo', { manifest: countedManifest(), install: () => {} })
    const toolOwners = new Map([['demo_tool', 'fixtures/demo']])
    const dispose = projectToolWrapper(ctx, {
      toolOwnerOf: name => toolOwners.get(name),
      projectRootOf: () => undefined,
      runGuard,
    })
    try {
      let bodyCalls = 0
      ctx.tools.register(tool('demo_tool', async () => { bodyCalls += 1; return 'ok' }))
      const watcher = runGuard.getWatcher('fixtures/demo')
      // The watcher arms maxCallCount=100 (the M2b explicit default); call
      // 101 times: every call up to the limit dispatches, the 101st is refused.
      for (let i = 0; i < 100; i += 1) {
        const result = await run(ctx, 'demo_tool')
        expect(result.isError, `call ${i + 1}`).toBe(false)
      }
      const refused = await run(ctx, 'demo_tool')
      expect(refused.isError).toBe(true)
      if (refused.isError) {
        expect(refused.error.info?.code).toBe('PLUGIN_GOVERNANCE')
        expect(refused.error.message).toContain('Exceeded maximum call count')
      }
      expect(bodyCalls).toBe(100)
      expect(watcher?.getHealthStatus().callCount).toBe(101)
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('maps a watcher timeout to a structured timeout error result', async () => {
    const ctx = await mount()
    const runGuard = new RunGuard()
    runGuard.watch('fixtures/demo', {
      manifest: testManifest({
        sandbox: testSandbox({
          resources: { memoryLimitMb: 128, cpuLimit: 50, timeoutMs: 30, maxOutputBytes: 10000 },
        }),
      }),
      install: () => {},
    })
    const toolOwners = new Map([['hang_tool', 'fixtures/demo']])
    const dispose = projectToolWrapper(ctx, {
      toolOwnerOf: name => toolOwners.get(name),
      projectRootOf: () => undefined,
      runGuard,
    })
    try {
      ctx.tools.register(tool('hang_tool', () => new Promise(resolve => setTimeout(() => { resolve('late') }, 200))))
      const result = await run(ctx, 'hang_tool')
      expect(result.isError).toBe(true)
      if (result.isError) {
        expect(result.error.info?.code).toBe('PLUGIN_TIMEOUT')
        expect(result.error.info?.name).toBe('PluginTimeoutError')
      }
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('passes non-project tools through unchanged (D-01)', async () => {
    const ctx = await mount()
    const runGuard = new RunGuard()
    const dispose = projectToolWrapper(ctx, {
      toolOwnerOf: () => undefined,
      projectRootOf: () => undefined,
      runGuard,
    })
    try {
      ctx.tools.register(tool('host_tool'))
      const result = await run(ctx, 'host_tool')
      expect(result.isError).toBe(false)
      if (!result.isError) expect(result.content[0]).toMatchObject({ type: 'text', text: 'ok' })
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })
})
