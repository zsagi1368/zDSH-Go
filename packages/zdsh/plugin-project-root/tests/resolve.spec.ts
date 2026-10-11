/**
 * Project plugin switch resolution (S-43 M1, A-01/A-03): only an explicit
 * `config.enabled === true` on the composed `project-plugins` row turns the
 * switch on. The function reads ONLY the composed row map — no environment,
 * no filesystem — so a project `.env` or any project-local file can never
 * place it (A7.3).
 */

import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { resolveProjectPluginEnabled, PROJECT_PLUGINS_ROW_ID } from '../src/resolve.ts'

function row(config: unknown, extra: Partial<EntryOptions> = {}): EntryOptions {
  return { id: PROJECT_PLUGINS_ROW_ID, name: 'project-plugins', config, ...extra }
}

function rowsOf(...entries: EntryOptions[]): Map<string, EntryOptions> {
  return new Map(entries.map(entry => [entry.id, entry]))
}

describe('resolveProjectPluginEnabled', () => {
  it('defaults to false with no row at all (A-01)', () => {
    expect(resolveProjectPluginEnabled(rowsOf())).toBe(false)
    expect(resolveProjectPluginEnabled(new Map())).toBe(false)
  })

  it('turns on only for an exact config.enabled === true', () => {
    expect(resolveProjectPluginEnabled(rowsOf(row({ enabled: true })))).toBe(true)
    for (const value of ['true', '1', 'yes', 1, 0, null, undefined, {}]) {
      expect(resolveProjectPluginEnabled(rowsOf(row({ enabled: value }))), JSON.stringify(value)).toBe(false)
    }
  })

  it('ignores rows without a config object', () => {
    expect(resolveProjectPluginEnabled(rowsOf(row(undefined)))).toBe(false)
    expect(resolveProjectPluginEnabled(rowsOf(row(null)))).toBe(false)
    expect(resolveProjectPluginEnabled(rowsOf(row('enabled')))).toBe(false)
  })

  it('reads only the composed rows: environment can never place the switch (A-03)', () => {
    // The switch has no env key: setting lookalike variables must not matter,
    // because the function never consults process.env at all.
    const previous = { ...process.env }
    process.env.DSH_PROJECT_PLUGINS_ENABLED = '1'
    process.env.PROJECT_PLUGINS_ENABLED = '1'
    try {
      expect(resolveProjectPluginEnabled(rowsOf())).toBe(false)
    } finally {
      if (previous.DSH_PROJECT_PLUGINS_ENABLED === undefined) delete process.env.DSH_PROJECT_PLUGINS_ENABLED
      else process.env.DSH_PROJECT_PLUGINS_ENABLED = previous.DSH_PROJECT_PLUGINS_ENABLED
      if (previous.PROJECT_PLUGINS_ENABLED === undefined) delete process.env.PROJECT_PLUGINS_ENABLED
      else process.env.PROJECT_PLUGINS_ENABLED = previous.PROJECT_PLUGINS_ENABLED
    }
  })

  it('lets user layers override the bundle default through the same composed row', () => {
    // Bundle declares false, the user layer patch retargets the same row id:
    // composition yields one row with the final value.
    const finalRow = row({ enabled: true }, { config: { enabled: true } })
    expect(resolveProjectPluginEnabled(rowsOf(finalRow))).toBe(true)
  })
})
