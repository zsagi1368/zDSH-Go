/**
 * Trigger source tests: candidate mapping over a stubbed search transport,
 * plain-text pick insertion aligned with the host grammar, and FR-B8 graceful
 * degradation when the feature toggle is off.
 */
import { describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

import {
  buildFileHubTriggerSource,
  readMentionDisabled,
  registerMentionTrigger,
} from '../../src/client/mention/source.js'
import type { SearchFetcher, SearchResponse } from '../../src/client/mention/search.js'

function makeSearchResponse(entries: Array<{ relativePath: string; kind: 'file' | 'directory' }>): SearchResponse {
  return { sessionId: 's1', entries: entries.map(entry => ({ ...entry, sizeBytes: 0, path: `/w/${entry.relativePath}` })), truncated: false }
}

const fetcher: SearchFetcher = async (_sessionId, query) =>
  makeSearchResponse(
    query === ''
      ? [{ relativePath: 'README.md', kind: 'file' }, { relativePath: 'src', kind: 'directory' }]
      : [{ relativePath: `src/${query}.ts`, kind: 'file' }],
  )

/** Structural session projection; the real type brands the id, tests need no brand. */
type AnySession = Parameters<ReturnType<typeof buildFileHubTriggerSource>['candidates']>[0]
const SESSION: AnySession = { sessionId: 's1' } as AnySession
const REQUEST = (query = '', quoted = false, drilled = false) => ({
  query,
  quoted,
  position: 'inline' as const,
  drilled,
  signal: new AbortController().signal,
})

describe('FileHub @ trigger source', () => {
  it('binds to the @ trigger with a unique group name', () => {
    const source = buildFileHubTriggerSource({ fetchSearch: fetcher, sessionId: () => 's1' })
    expect(source.trigger).toBe('@')
    expect(source.name).toBe('filehub')
  })

  it('maps search results into menu candidates carrying parseable values', async () => {
    const source = buildFileHubTriggerSource({ fetchSearch: fetcher, sessionId: () => 's1' })
    const candidates = await source.candidates(SESSION, REQUEST('deep'))
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ name: 'deep.ts', description: 'src' })
    expect(JSON.parse(candidates[0]!.value as string)).toEqual({ p: 'src/deep.ts', k: 'file' })
  })

  it('onPick inserts the host-grammar token plus one trailing space', async () => {
    const source = buildFileHubTriggerSource({ fetchSearch: fetcher, sessionId: () => 's1' })
    const [candidate] = await source.candidates(SESSION, REQUEST('deep'))
    const outcome = source.onPick({
      candidate: candidate!,
      session: SESSION,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    })
    expect(outcome).toEqual({ text: '@src/deep.ts ' })

    // Directory candidates keep the trailing slash of the grammar.
    const [dir] = await source.candidates(SESSION, REQUEST(''))
    void dir
    const dirCandidate = {
      ...candidate!,
      value: JSON.stringify({ p: 'src', k: 'directory' }),
    }
    const dirOutcome = source.onPick({
      candidate: dirCandidate,
      session: SESSION,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    })
    expect(dirOutcome).toEqual({ text: '@src/ ' })
  })

  it('formats whitespace paths through the quoted grammar', async () => {
    const spacedFetcher: SearchFetcher = async () =>
      makeSearchResponse([{ relativePath: 'docs/my notes.md', kind: 'file' }])
    const source = buildFileHubTriggerSource({ fetchSearch: spacedFetcher, sessionId: () => 's1' })
    const [candidate] = await source.candidates(SESSION, REQUEST())
    const outcome = source.onPick({
      candidate: candidate!,
      session: SESSION,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    })
    expect(outcome).toEqual({ text: '@"docs/my notes.md" ' })
  })

  it('returns undefined for corrupt candidate payloads instead of throwing', () => {
    const source = buildFileHubTriggerSource({ fetchSearch: fetcher, sessionId: () => 's1' })
    expect(source.onPick({
      candidate: { name: 'x', value: '{not json' },
      session: SESSION,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toBeUndefined()
  })
})

describe('FR-B8 graceful degradation', () => {
  function fakeStorage(disabled: string | null): Storage {
    return {
      get length() {
        return 0
      },
      clear: () => undefined,
      getItem: (_key: string) => disabled,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
    }
  }

  it('reads the localStorage flag', () => {
    expect(readMentionDisabled(fakeStorage(null))).toBe(false)
    expect(readMentionDisabled(fakeStorage('1'))).toBe(true)
    expect(readMentionDisabled(fakeStorage('0'))).toBe(false)
  })

  it('skips registration entirely when disabled — no throw, no service access', () => {
    let serviceTouched = false
    const ctx = {
      logger: { info: () => undefined, warn: () => undefined },
      get(name: string): unknown {
        if (name === 'inputTriggers') serviceTouched = true
        return undefined
      },
    } as unknown as ClientContext
    const disposer = registerMentionTrigger(ctx, { storage: fakeStorage('1') })
    expect(disposer).toBeUndefined()
    expect(serviceTouched).toBe(false)
  })

  it('degrades loud-but-safe when the inputTriggers service is absent', () => {
    const warns: string[] = []
    const ctx = {
      logger: { info: () => undefined, warn: (line: string) => warns.push(line) },
      get: () => undefined,
    } as unknown as ClientContext
    const disposer = registerMentionTrigger(ctx, { storage: fakeStorage(null) })
    expect(disposer).toBeUndefined()
    expect(warns.join('\n')).toContain('inputTriggers service unavailable')
  })
})
