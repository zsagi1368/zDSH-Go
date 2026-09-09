/**
 * V4 D4-2: the scoped-context swallow branch of `applyChildComposition`
 * (child-agent.ts). `tools.restrict()` only accepts an agent-scoped context;
 * when the tool registry cannot see the child's scope it refuses with
 * "requires a scoped context", and that single refusal must be swallowed so
 * the child stays creatable on the parent's inherited tool world. Any other
 * restriction failure is real and must fail the creation window.
 *
 * The child context is a structural fake: `applyChildComposition` touches
 * exactly `ctx.get('agentPresets')`, `ctx.systemPrompt.context/section` and
 * `ctx.tools.restrict`, so no host closure is needed to pin the branch.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyChildComposition, SUBAGENT_DELEGATION_CONTEXT } from '../src/child-agent.ts'

/** A child scope context exposing only what the composition touches. */
function fakeChildCtx(restrict: (filter: unknown) => void) {
  const context = vi.fn()
  const section = vi.fn()
  // Distinctive non-literal orders: the composition must forward whatever the
  // system-prompt service reports, proving the order is dynamic rather than a
  // value hardcoded in child-agent.ts.
  const getContextOrder = vi.fn(() => 210)
  const getSectionOrder = vi.fn(() => 5)
  const ctx = {
    // No agentPresets composed: the join is skipped via optional chaining.
    get: () => undefined,
    systemPrompt: { context, section, getContextOrder, getSectionOrder },
    tools: { restrict },
  }
  return { ctx: ctx as unknown as Context, context, section, getContextOrder, getSectionOrder }
}

function fakeParent(): Agent {
  return { ctx: {} } as unknown as Agent
}

describe('applyChildComposition tool-filter scoped-context branch', () => {
  it('swallows the "requires a scoped context" refusal and keeps the composition', () => {
    const restrict = vi.fn(() => {
      throw new Error('dsh-tools: tools.restrict() requires a scoped context')
    })
    const { ctx, context, section, getContextOrder, getSectionOrder } = fakeChildCtx(restrict)
    expect(() => {
      applyChildComposition(ctx, fakeParent(), {
        persona: 'child persona',
        toolFilter: { deny: ['subagent'] },
      })
    }).not.toThrow()
    // The delegation context and the shadowing persona landed before the
    // swallowed refusal — the child is composed, just unrestricted. The order
    // is whatever the system-prompt service reports (dynamic, not hardcoded).
    expect(getContextOrder).toHaveBeenCalledWith('SUBAGENT_DELEGATION')
    expect(context).toHaveBeenCalledWith({
      name: 'subagent:delegation',
      order: 210,
      text: SUBAGENT_DELEGATION_CONTEXT,
    })
    expect(getSectionOrder).toHaveBeenCalledWith('DEPLOYMENT_PERSONA')
    expect(section).toHaveBeenCalledWith({
      name: 'deployment:persona',
      order: 5,
      text: 'child persona',
    })
    expect(restrict).toHaveBeenCalledWith({ deny: ['subagent'] })
  })

  it('rethrows any other Error from the restriction', () => {
    const restrict = vi.fn(() => {
      throw new Error('unknown tool: dangerous')
    })
    const { ctx } = fakeChildCtx(restrict)
    expect(() => {
      applyChildComposition(ctx, fakeParent(), {
        toolFilter: { deny: ['dangerous'] },
      })
    }).toThrow('unknown tool: dangerous')
  })

  it('rethrows a non-Error throwable unchanged', () => {
    // The swallow arm is `error instanceof Error`-gated: a raw string refusal
    // cannot match it and must propagate untouched.
    const restrict = vi.fn(() => {
      throw 'scoped-context-lookalike'
    })
    const { ctx } = fakeChildCtx(restrict)
    let caught: unknown
    try {
      applyChildComposition(ctx, fakeParent(), { toolFilter: { allow: [] } })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBe('scoped-context-lookalike')
  })

  it('never calls restrict when no tool filter is composed', () => {
    const restrict = vi.fn()
    const { ctx } = fakeChildCtx(restrict)
    applyChildComposition(ctx, fakeParent(), {})
    expect(restrict).not.toHaveBeenCalled()
  })
})
