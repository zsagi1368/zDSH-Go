import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import ModelSlotRegistry, {
  MODEL_SLOT_COMPACTION_SUMMARIZE,
  MODEL_SLOT_IDS,
  MODEL_SLOT_PLAN,
  MODEL_SLOT_TITLE,
  MODEL_SLOTS_SETTINGS_SCHEMA,
  SlotId,
  resolveModelSlotsConfig,
} from '../src/index.ts'

type RegistryConfig = ConstructorParameters<typeof ModelSlotRegistry>[1]

function makeRegistry(config?: RegistryConfig): ModelSlotRegistry {
  return new ModelSlotRegistry(new Context(), config)
}

async function mountedSession(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('slot-audit'))
  return { ctx, session }
}

describe('resolveModelSlotsConfig', () => {
  it('accepts an empty policy and freezes the resolved result', () => {
    const resolved = resolveModelSlotsConfig({})
    expect(resolved.routes.size).toBe(0)
    expect(resolved.fallback).toBeUndefined()
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.routes)).toBe(true)
    expect(resolveModelSlotsConfig().routes.size).toBe(0)
  })

  it('resolves built-in slot entries and the fallback as detached frozen routes', () => {
    const resolved = resolveModelSlotsConfig({
      slots: {
        [MODEL_SLOT_TITLE]: { provider: 'aux-provider', model: 'aux-model' },
        [MODEL_SLOT_COMPACTION_SUMMARIZE]: { provider: 'summarize-provider', model: 'summary-model' },
        [MODEL_SLOT_PLAN]: { provider: 'plan-provider', model: 'plan-model' },
      },
      fallback: { provider: 'default-provider', model: 'default-model' },
    })
    expect(resolved.routes.get(MODEL_SLOT_TITLE)).toEqual({ provider: 'aux-provider', model: 'aux-model' })
    expect(resolved.routes.get(MODEL_SLOT_COMPACTION_SUMMARIZE)).toEqual({
      provider: 'summarize-provider',
      model: 'summary-model',
    })
    expect(resolved.routes.get(MODEL_SLOT_PLAN)).toEqual({ provider: 'plan-provider', model: 'plan-model' })
    expect(resolved.fallback).toEqual({ provider: 'default-provider', model: 'default-model' })
    expect(Object.isFrozen(resolved.routes.get(MODEL_SLOT_TITLE))).toBe(true)
    expect(Object.isFrozen(resolved.fallback)).toBe(true)
  })

  it('rejects stale keys, unknown slots, and unpaired or blank routes', () => {
    expect(() => resolveModelSlotsConfig({ route: {} } as never)).toThrow(/unknown config key "route"/)
    expect(() => resolveModelSlotsConfig({ slots: { tittel: { provider: 'a', model: 'b' } } }))
      .toThrow(/unknown slot "tittel"/)
    expect(() => resolveModelSlotsConfig({ slots: { title: ['a', 'b'] as never } }))
      .toThrow(/slots\.title must be an object/)
    expect(() => resolveModelSlotsConfig({ slots: { title: { provider: 'a', model: '' } } }))
      .toThrow(/slots\.title\.model must be a non-empty string/)
    expect(() => resolveModelSlotsConfig({ slots: { title: { provider: '', model: 'b' } } }))
      .toThrow(/slots\.title\.provider must be a non-empty string/)
    expect(() => resolveModelSlotsConfig({ slots: { title: { provider: 'a', model: 'b', extra: 1 } as never } }))
      .toThrow(/slots\.title has unknown key "extra"/)
    expect(() => resolveModelSlotsConfig({ fallback: { provider: 'a' } as never }))
      .toThrow(/fallback\.model must be a non-empty string/)
    expect(() => resolveModelSlotsConfig(null as never)).toThrow(/configuration must be an object/)
  })

  it('accepts the derived apiKeyEnv reference on settings-style entries', () => {
    const resolved = resolveModelSlotsConfig({
      slots: {
        [MODEL_SLOT_TITLE]: { provider: 'anthropic', model: 'claude-3', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
    })
    expect(resolved.routes.get(MODEL_SLOT_TITLE)).toEqual({ provider: 'anthropic', model: 'claude-3' })
  })

  it('rejects an unknown key alongside apiKeyEnv', () => {
    expect(() => resolveModelSlotsConfig({
      slots: { [MODEL_SLOT_TITLE]: { provider: 'a', model: 'b', apiKeyEnv: 'A_API_KEY', secret: 'sk-literal' } as never },
    })).toThrow(/slots\.title has unknown key "secret"/)
  })
})

describe('MODEL_SLOTS_SETTINGS_SCHEMA', () => {
  it('refuses a literal API key at the schema layer', () => {
    expect(() => MODEL_SLOTS_SETTINGS_SCHEMA({ slots: { title: { provider: 'a', model: 'b', apiKeyEnv: 'sk-literal-123' } } }))
      .toThrow()
    expect(() => MODEL_SLOTS_SETTINGS_SCHEMA({ slots: { title: { provider: 'a', model: 'b', apiKeyEnv: 'ANTHROPIC_API_KEY' } } }))
      .not.toThrow()
  })

  it('pins the closed slot vocabulary at the schema layer, not only at the registry', () => {
    // The vocabulary is a closed built-in set (vocabulary.ts MODEL_SLOT_IDS);
    // the dict's key schema derives from it, so a foreign key fails validation
    // in the loader's pre-persist resolveConfig instead of landing in the
    // profile and taking this entry's service down on the next boot — where the
    // Models page could not repair it, since SettingsForms.describe() hides
    // non-ACTIVE entries.
    for (const id of MODEL_SLOT_IDS) {
      expect(() => MODEL_SLOTS_SETTINGS_SCHEMA({ slots: { [id]: { provider: 'a', model: 'b' } } })).not.toThrow()
    }
    expect(() => MODEL_SLOTS_SETTINGS_SCHEMA({ slots: { nope: { provider: 'a', model: 'b' } } }))
      .toThrow(/expected "title" \| "compaction\.summarize" \| "vision" \| "plan" but got "nope"/)
    // The runtime Config carries the same node, so the loader gate closes too.
    expect(() => ModelSlotRegistry.Config({ slots: { nope: { provider: 'a', model: 'b' } } })).toThrow(/"nope"/)
    // An empty or omitted policy still validates: the closed keys reject
    // foreign ids without materializing unset ones.
    expect(() => MODEL_SLOTS_SETTINGS_SCHEMA({})).not.toThrow()
    expect(() => MODEL_SLOTS_SETTINGS_SCHEMA({ slots: {} })).not.toThrow()
  })
})

describe('ModelSlotRegistry.Config (settings-writable surface)', () => {
  it('marks both policy fields volatile so the settings face can write them', () => {
    // The settings face refuses a write outside a volatile path, and the
    // Loader commits a volatile-only change into the running entry instead of
    // remounting it; this pair is what makes the entry's own Config the
    // user-layer write face on the 0.1.7 settings surface. The resolved-value
    // side of the same contract (a live reference re-pointing a slot without a
    // remount) is locked in loader-composition.spec.ts.
    expect(ModelSlotRegistry.Config.dict?.slots?.meta.volatile).toBe(true)
    expect(ModelSlotRegistry.Config.dict?.fallback?.meta.volatile).toBe(true)
  })
})

describe('resolve precedence', () => {
  it.each([MODEL_SLOT_TITLE, MODEL_SLOT_COMPACTION_SUMMARIZE, MODEL_SLOT_PLAN] as const)(
    'prefers the explicit slot statement over the deployment default and the main route for %s',
    (slot) => {
      const registry = makeRegistry({
        slots: { [slot]: { provider: 'slot-provider', model: 'slot-model' } },
        fallback: { provider: 'default-provider', model: 'default-model' },
      })
      expect(registry.resolve(slot, { mainRoute: { provider: 'main-provider', model: 'main-model' } })).toEqual({
        slot,
        provider: 'slot-provider',
        model: 'slot-model',
        source: 'slot',
      })
    },
  )

  it.each([MODEL_SLOT_TITLE, MODEL_SLOT_COMPACTION_SUMMARIZE, MODEL_SLOT_PLAN] as const)(
    'applies the deployment default ahead of the main route for %s',
    (slot) => {
      const registry = makeRegistry({ fallback: { provider: 'default-provider', model: 'default-model' } })
      expect(registry.resolve(slot, { mainRoute: { provider: 'main-provider', model: 'main-model' } })).toEqual({
        slot,
        provider: 'default-provider',
        model: 'default-model',
        source: 'deployment-default',
      })
    },
  )

  it.each([MODEL_SLOT_TITLE, MODEL_SLOT_COMPACTION_SUMMARIZE, MODEL_SLOT_PLAN] as const)(
    'falls back to the conversation main route when no deployment statement covers %s',
    (slot) => {
      const registry = makeRegistry({})
      expect(registry.resolve(slot, { mainRoute: { provider: 'main-provider', model: 'main-model' } })).toEqual({
        slot,
        provider: 'main-provider',
        model: 'main-model',
        source: 'main-route',
      })
    },
  )

  it('returns null when every tier is unavailable', () => {
    const registry = makeRegistry({})
    expect(registry.resolve(MODEL_SLOT_TITLE)).toBeNull()
    expect(registry.resolve(MODEL_SLOT_TITLE, {})).toBeNull()
  })

  it('freezes resolutions and serves repeated reads without mutating state', () => {
    const registry = makeRegistry({ slots: { [MODEL_SLOT_TITLE]: { provider: 'p', model: 'm' } } })
    const first = registry.resolve(MODEL_SLOT_TITLE)
    expect(first).not.toBeNull()
    expect(Object.isFrozen(first)).toBe(true)
    expect(registry.resolve(MODEL_SLOT_TITLE)).toEqual(first)
  })
})

describe('programmatic registration lifecycle', () => {
  it('registers, resolves, disposes, and allows re-registration', () => {
    const registry = makeRegistry({})
    const dispose = registry.register(SlotId('title'), { provider: 'aux-provider', model: 'aux-model' })
    expect(registry.resolve(MODEL_SLOT_TITLE)?.provider).toBe('aux-provider')
    dispose()
    expect(registry.resolve(MODEL_SLOT_TITLE, { mainRoute: { provider: 'main', model: 'main' } })?.source)
      .toBe('main-route')
    const secondDispose = registry.register(MODEL_SLOT_TITLE, { provider: 'next-provider', model: 'next-model' })
    expect(registry.resolve(MODEL_SLOT_TITLE)?.provider).toBe('next-provider')
    // A stale disposer captured earlier cannot remove the newer registration.
    dispose()
    expect(registry.resolve(MODEL_SLOT_TITLE)?.provider).toBe('next-provider')
    secondDispose()
    expect(registry.resolve(MODEL_SLOT_TITLE)).toBeNull()
  })

  it('rejects duplicate live registrations and configuration-owned slots', () => {
    const registry = makeRegistry({ slots: { [MODEL_SLOT_COMPACTION_SUMMARIZE]: { provider: 'p', model: 'm' } } })
    const dispose = registry.register(MODEL_SLOT_TITLE, { provider: 'p', model: 'm' })
    expect(() => registry.register(MODEL_SLOT_TITLE, { provider: 'q', model: 'm' }))
      .toThrow(/slot "title" is already registered/)
    expect(() => registry.register(MODEL_SLOT_COMPACTION_SUMMARIZE, { provider: 'q', model: 'm' }))
      .toThrow(/slot "compaction.summarize" is owned by deployment configuration/)
    dispose()
  })

  it('rejects incomplete registration routes', () => {
    const registry = makeRegistry({})
    expect(() => registry.register(MODEL_SLOT_TITLE, { provider: '', model: 'm' }))
      .toThrow(/registration for slot "title"\.provider must be a non-empty string/)
    expect(() => registry.register(MODEL_SLOT_TITLE, { provider: 'p' } as never))
      .toThrow(/registration for slot "title"\.model must be a non-empty string/)
  })
})

describe('durable dispatch audit records', () => {
  it('appends one exact pre-dispatch record per resolution with a session sink', async () => {
    const { ctx, session } = await mountedSession()
    const registry = new ModelSlotRegistry(ctx, {
      slots: { [MODEL_SLOT_TITLE]: { provider: 'aux-provider', model: 'aux-model' } },
    })
    registry.resolve(MODEL_SLOT_TITLE, { session })
    const record = session.snapshotEvents().findLast(event => event.type === 'slots/dispatch')
    expect(record?.data).toEqual({
      slot: MODEL_SLOT_TITLE,
      provider: 'aux-provider',
      model: 'aux-model',
      source: 'slot',
    })
    registry.resolve(MODEL_SLOT_COMPACTION_SUMMARIZE, {
      session,
      mainRoute: { provider: 'main-provider', model: 'main-model' },
    })
    const records = session.snapshotEvents().filter(event => event.type === 'slots/dispatch')
    expect(records).toHaveLength(2)
    expect(records[1]?.data).toMatchObject({
      slot: MODEL_SLOT_COMPACTION_SUMMARIZE,
      source: 'main-route',
    })
  })

  it('appends nothing when no route resolves or when called without a sink', async () => {
    const { ctx, session } = await mountedSession()
    const registry = new ModelSlotRegistry(ctx, {})
    expect(registry.resolve(MODEL_SLOT_TITLE, { session })).toBeNull()
    expect(session.snapshotEvents().some(event => event.type === 'slots/dispatch')).toBe(false)
    expect(registry.resolve(MODEL_SLOT_TITLE, { mainRoute: { provider: 'p', model: 'm' } })).not.toBeNull()
    expect(session.snapshotEvents().some(event => event.type === 'slots/dispatch')).toBe(false)
  })
})
