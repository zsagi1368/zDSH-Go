import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore from '@deepseek-ai/dsh-session'
import ModelSlotRegistry, { MODEL_SLOT_TITLE } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-model-slots-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-model-slots', ModelSlotRegistry],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('loads the shipped model-slots YAML row and serves the configured slot', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-model-slots'",
      '  config:',
      '    slots:',
      '      title:',
      '        provider: aux-provider',
      '        model: aux-model',
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('modelSlots')).toBeInstanceOf(ModelSlotRegistry)
    expect(loaded.get('modelSlots')?.resolve(MODEL_SLOT_TITLE)).toEqual({
      slot: MODEL_SLOT_TITLE,
      provider: 'aux-provider',
      model: 'aux-model',
      source: 'slot',
    })
  })

  it('re-points a slot when the entry adopts a user-layer policy through the volatile commit path', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-session'",
      '- id: llm-model-slots',
      "  name: '@deepseek-ai/dsh-model-slots'",
      '  config:',
      '    slots:',
      '      title:',
      '        provider: aux-provider',
      '        model: aux-model',
    ])

    const registry = loaded.get('modelSlots')
    expect(registry?.resolve(MODEL_SLOT_TITLE)).toEqual({
      slot: MODEL_SLOT_TITLE,
      provider: 'aux-provider',
      model: 'aux-model',
      source: 'slot',
    })

    // The settings face addresses a plugin entry by its Loader id and writes
    // only volatile paths: this row id is the namespace literal the Models
    // page's slot block pins.
    const entry = [...loaded.loader.entries()].find(row => row.options.id === 'llm-model-slots')
    expect(entry?.options.name).toBe('@deepseek-ai/dsh-model-slots')
    // The ordinary update path announces a partial dispose and remounts the
    // entry; a volatile commit must stay silent.
    let remounts = 0
    loaded.on('loader/partial-dispose', () => { remounts++ })

    await entry?.update({
      config: { slots: { [MODEL_SLOT_TITLE]: { provider: 'user-provider', model: 'user-model' } } },
    })

    expect(remounts).toBe(0)
    // The running registry re-reads its live references, so the user layer
    // re-points later auxiliary calls without a remount.
    expect(registry?.resolve(MODEL_SLOT_TITLE)).toEqual({
      slot: MODEL_SLOT_TITLE,
      provider: 'user-provider',
      model: 'user-model',
      source: 'slot',
    })
  })

  it('keeps the previous routes and warns once when a live policy edit is rejected', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-session'",
      '- id: llm-model-slots',
      "  name: '@deepseek-ai/dsh-model-slots'",
      '  config:',
      '    slots:',
      '      title:',
      '        provider: aux-provider',
      '        model: aux-model',
    ])
    const warnings: string[] = []
    loaded.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof loaded.logger.warn

    const entry = [...loaded.loader.entries()].find(row => row.options.id === 'llm-model-slots')
    // The unknown *slot key* is refused earlier now (by the schema, before the
    // write lands — see the closed-vocabulary case below); what still reaches
    // the registry is a route entry whose field set the open entry object lets
    // through, and that is the rejection this case locks.
    await entry?.update({ config: { slots: { title: { provider: 'x', model: 'y', exotic: true } } } })

    expect(loaded.get('modelSlots')?.resolve(MODEL_SLOT_TITLE)).toEqual({
      slot: MODEL_SLOT_TITLE,
      provider: 'aux-provider',
      model: 'aux-model',
      source: 'slot',
    })
    expect(warnings.filter(line => line.includes('live slot policy rejected'))).toHaveLength(1)
  })

  it('keeps the running routes when the loader tries to commit a foreign slot key', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-session'",
      '- id: llm-model-slots',
      "  name: '@deepseek-ai/dsh-model-slots'",
      '  config:',
      '    slots:',
      '      title:',
      '        provider: aux-provider',
      '        model: aux-model',
    ])
    const warnings: string[] = []
    loaded.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof loaded.logger.warn
    const entry = [...loaded.loader.entries()].find(row => row.options.id === 'llm-model-slots')

    // The loader's volatile commit resolves the candidate through the Config
    // schema, so the closed key set rejects the foreign id there: the running
    // references never receive it and the registry never has to fall back.
    await entry?.update({ config: { slots: { nope: { provider: 'x', model: 'y' } } } })

    expect(warnings.some(line => line.includes('volatile config update failed'))).toBe(true)
    expect(warnings.filter(line => line.includes('live slot policy rejected'))).toEqual([])
    expect(loaded.get('modelSlots')?.resolve(MODEL_SLOT_TITLE)).toEqual({
      slot: MODEL_SLOT_TITLE,
      provider: 'aux-provider',
      model: 'aux-model',
      source: 'slot',
    })
    // The rejected raw config stays retained on the entry (the loader keeps it
    // for the next activation) — which is exactly why the settings face must
    // refuse it before persisting; that pre-persist gate is locked in
    // settings-write-gate.spec.ts.
    expect(entry?.options.config).toEqual({ slots: { nope: { provider: 'x', model: 'y' } } })
  })

  it('rejects stale model-slots config after Schemastery normalization', async () => {
    context = new Context()
    await expect(context.plugin(ModelSlotRegistry, {
      route: { provider: 'a', model: 'b' },
    } as never)).rejects.toThrow(/unknown config key "route"/)
  })

  it('rejects an unknown slot id during direct construction', () => {
    expect(() => new ModelSlotRegistry(new Context(), {
      slots: { nope: { provider: 'a', model: 'b' } },
    })).toThrow(/unknown slot "nope"/)
  })
})
