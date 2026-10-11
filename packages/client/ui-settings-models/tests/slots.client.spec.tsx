// @vitest-environment jsdom
/** Auxiliary-model slot block: read-only route/source rows and the vision-slot editor. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SlotsBlock } from '../src/client/SlotsBlock.tsx'
import { deriveKeyRef, MODEL_SLOTS_SETTINGS_NAMESPACE } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t: (key: keyof typeof en) => string = key => en[key]

/** The slot-policy schema the host registers, mirroring `@deepseek-ai/dsh-model-slots`. */
const SlotsSchema = Schema.object({
  slots: Schema.dict(Schema.object({
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
    apiKeyEnv: Schema.string().pattern(/^[A-Z][A-Z0-9_]*$/),
  })),
  fallback: Schema.object({
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
    apiKeyEnv: Schema.string().pattern(/^[A-Z][A-Z0-9_]*$/),
  }),
})

function namespace(value: JsonValue, revision = 0): SettingsNamespaceView {
  return {
    // zDSH (SYNC-P2): 0.1.7 added autoGenerate to the wire view; the slots
    // namespace renders through the models section block, never a generated page.
    autoGenerate: false,
    ns: MODEL_SLOTS_SETTINGS_NAMESPACE,
    schema: JSON.parse(JSON.stringify(SlotsSchema.toJSON())) as JsonValue,
    value,
    applies: 'live',
    secrets: [],
    revision,
  }
}

/** ClientResult shape returned by the settings Remote mutate method. */
type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { code: string; message: string; details: object } }

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

const PROVIDERS = [
  { provider: 'deepseek-official', displayName: 'DeepSeek' },
  { provider: 'openai', displayName: 'openai' },
]

function wire(overrides: {
  mutate?: ReturnType<typeof vi.fn>
  resolveModelInfo?: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] }>
} = {}) {
  const mutate = overrides.mutate ?? vi.fn(() => Promise.resolve(ok(namespace({}))))
  const face = {
    llm: {
      resolveModelInfo: overrides.resolveModelInfo,
    },
    settings: { mutate },
  }
  return { face, mutate }
}

function mountBlock(
  view: SettingsNamespaceView | undefined,
  options: {
    providers?: typeof PROVIDERS
    readOnly?: boolean
    mutate?: ReturnType<typeof vi.fn>
    resolveModelInfo?: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] }>
    onSaved?: () => void
  } = {},
) {
  const { face, mutate } = wire(options)
  render(<SlotsBlock
    namespace={view}
    providers={options.providers ?? PROVIDERS}
    api={face as never}
    schema={settingsSchema}
    t={t}
    readOnly={options.readOnly ?? false}
    onSaved={options.onSaved ?? (() => {})}
  />)
  return { mutate }
}

describe('SlotsBlock read-only rows', () => {
  it('shows every built-in slot with its effective route and source tier', () => {
    mountBlock(namespace({
      slots: {
        title: { provider: 'deepseek-official', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
        vision: { provider: 'openai', model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY' },
      },
      fallback: { provider: 'def', model: 'def-model', apiKeyEnv: 'DEF_API_KEY' },
    }))
    expect(screen.getByText(en.slotsTitle)).toBeTruthy()
    expect(screen.getByText(en.slotTitle)).toBeTruthy()
    expect(screen.getByText(en.slotCompaction)).toBeTruthy()
    expect(screen.getByText(en.slotVision)).toBeTruthy()

    // title: explicit statement.
    expect(screen.getByText('deepseek-official/deepseek-v4-flash')).toBeTruthy()
    expect(screen.getAllByText(en.slotSourceExplicit)).toHaveLength(2)
    // compaction.summarize: deployment default.
    expect(screen.getByText('def/def-model')).toBeTruthy()
    expect(screen.getAllByText(en.slotSourceDeploymentDefault)).toHaveLength(1)
    // vision: explicit statement wins over the default.
    expect(screen.getByText('openai/gpt-4o')).toBeTruthy()
  })

  it('falls through to the deployment default and then the main-route tier', () => {
    mountBlock(namespace({ fallback: { provider: 'def', model: 'def-model' } }))
    expect(screen.getAllByText('def/def-model')).toHaveLength(3)
    expect(screen.getAllByText(en.slotSourceDeploymentDefault)).toHaveLength(3)

    cleanup()
    mountBlock(namespace({}))
    expect(screen.getAllByText(en.slotUnset)).toHaveLength(3)
    expect(screen.getAllByText(en.slotSourceMainRoute)).toHaveLength(3)
    expect(screen.getAllByText(en.slotSourceMainRouteHint)).toHaveLength(3)
  })

  it('renders an absent namespace as all main-route rows', () => {
    mountBlock(undefined)
    expect(screen.getAllByText(en.slotUnset)).toHaveLength(3)
    expect(screen.getAllByText(en.slotSourceMainRoute)).toHaveLength(3)
  })
})

describe('SlotsBlock vision editor', () => {
  it('saves the vision slot with a derived credential reference', async () => {
    const onSaved = vi.fn()
    const { mutate } = mountBlock(namespace({}), { onSaved })
    fireEvent.click(screen.getByLabelText(en.visionEdit))

    const provider = screen.getByLabelText(en.visionProviderLabel) as HTMLSelectElement
    fireEvent.change(provider, { target: { value: 'openai' } })
    // The derived reference appears as soon as a provider is chosen.
    expect(screen.getByText(`Credential reference: ${deriveKeyRef('openai')}`)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en.visionModelLabel), { target: { value: 'gpt-4o' } })
    fireEvent.click(screen.getByText(en.visionSave))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]?.[0]).toBe(MODEL_SLOTS_SETTINGS_NAMESPACE)
    expect(mutate.mock.calls[0]?.[1]).toEqual([{
      op: 'set',
      path: ['slots', 'vision'],
      value: { provider: 'openai', model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY' },
    }])
    expect(mutate.mock.calls[0]?.[2]).toBe(0)
    expect(onSaved).toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(en.visionSaved)
  })

  it('refuses a model without image input and never writes', async () => {
    const onSaved = vi.fn()
    const { mutate } = mountBlock(namespace({}), {
      onSaved,
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
    })
    fireEvent.click(screen.getByLabelText(en.visionEdit))
    fireEvent.change(screen.getByLabelText(en.visionProviderLabel), { target: { value: 'openai' } })
    fireEvent.change(screen.getByLabelText(en.visionModelLabel), { target: { value: 'gpt-4o' } })
    fireEvent.click(screen.getByText(en.visionSave))

    await screen.findByText(en.visionModelImageRequired)
    expect(mutate).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('refuses an unverifiable model when the probe rejects', async () => {
    const { mutate } = mountBlock(namespace({}), {
      resolveModelInfo: async () => { throw new Error('adapter down') },
    })
    fireEvent.click(screen.getByLabelText(en.visionEdit))
    fireEvent.change(screen.getByLabelText(en.visionProviderLabel), { target: { value: 'openai' } })
    fireEvent.change(screen.getByLabelText(en.visionModelLabel), { target: { value: 'gpt-4o' } })
    fireEvent.click(screen.getByText(en.visionSave))
    await screen.findByText(en.visionModelUnverified)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('saves without a capability probe (the runtime gate stays authoritative)', async () => {
    const { mutate } = mountBlock(namespace({}))
    fireEvent.click(screen.getByLabelText(en.visionEdit))
    fireEvent.change(screen.getByLabelText(en.visionProviderLabel), { target: { value: 'openai' } })
    fireEvent.change(screen.getByLabelText(en.visionModelLabel), { target: { value: 'gpt-4o' } })
    fireEvent.click(screen.getByText(en.visionSave))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
  })

  it('requires both a provider and a model before saving', async () => {
    const { mutate } = mountBlock(namespace({}))
    fireEvent.click(screen.getByLabelText(en.visionEdit))
    fireEvent.click(screen.getByText(en.visionSave))
    await screen.findByText(en.visionRouteRequired)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('clears the vision slot with an unset op', async () => {
    const onSaved = vi.fn()
    const { mutate } = mountBlock(namespace({
      slots: { vision: { provider: 'openai', model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY' } },
    }), { onSaved })
    fireEvent.click(screen.getByLabelText(en.visionEdit))
    fireEvent.click(screen.getByText(en.visionUnset))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]?.[0]).toBe(MODEL_SLOTS_SETTINGS_NAMESPACE)
    expect(mutate.mock.calls[0]?.[1]).toEqual([{ op: 'unset', path: ['slots', 'vision'] }])
    expect(mutate.mock.calls[0]?.[2]).toBe(0)
    expect(onSaved).toHaveBeenCalled()
  })

  it('hides the edit control when read-only', () => {
    mountBlock(namespace({}), { readOnly: true })
    expect(screen.queryByLabelText(en.visionEdit)).toBeNull()
  })

})
