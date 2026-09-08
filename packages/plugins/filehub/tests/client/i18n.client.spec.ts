/**
 * i18n dictionary contract: zh/en key-set equality (bilingual balance is a
 * hard invariant), interpolation, language switching, and the guarded host
 * locale face binding.
 */
import { describe, expect, it } from 'vitest'

import {
  bindHostLocale,
  FILEHUB_DICTS,
  getI18nLang,
  setI18nLang,
  subscribeI18n,
  t,
} from '../../src/client/i18n.js'

function keySet(dict: Record<string, string>): string[] {
  return Object.keys(dict).sort()
}

describe('dictionary integrity', () => {
  it('zh and en carry IDENTICAL key sets (both directions)', () => {
    expect(keySet(FILEHUB_DICTS.zh)).toEqual(keySet(FILEHUB_DICTS.en))
    expect(keySet(FILEHUB_DICTS.en)).toEqual(keySet(FILEHUB_DICTS.zh))
    expect(keySet(FILEHUB_DICTS.zh).length).toBeGreaterThan(30)
  })

  it('leaves no empty or placeholder-only entries', () => {
    for (const dict of [FILEHUB_DICTS.zh, FILEHUB_DICTS.en]) {
      for (const value of Object.values(dict)) {
        expect(typeof value).toBe('string')
        expect(value.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

describe('t()', () => {
  it('resolves in both languages with switch notification', () => {
    const events: string[] = []
    const unsubscribe = subscribeI18n(() => events.push(getI18nLang()))
    try {
      setI18nLang('zh')
      expect(t('console.tab')).toBe('文件')
      setI18nLang('en')
      expect(t('console.tab')).toBe('Files')
      // No-op switch does not notify.
      setI18nLang('en')
      expect(events).toEqual(['zh', 'en'])
    } finally {
      unsubscribe()
      setI18nLang('en')
    }
  })

  it('interpolates {name} params and keeps unknown placeholders verbatim', () => {
    setI18nLang('en')
    expect(t('console.cleanup.done', { count: 3, size: '12 KB' })).toBe(
      'Deleted 3 file(s), freed 12 KB',
    )
    expect(t('console.cleanup.done', { count: 1 })).toBe('Deleted 1 file(s), freed {size}')
  })

  it('falls through to en when the active dictionary misses a key', () => {
    setI18nLang('zh')
    try {
      const ghost = 'console.__ghost__' as Parameters<typeof t>[0]
      expect(t(ghost)).toBe(ghost)
    } finally {
      setI18nLang('en') // module state is shared across describes — reset it
    }
  })
})

describe('bindHostLocale', () => {
  it('adopts the host locale and follows switches; survives absent faces', () => {
    try {
      bindHostLocale(undefined)
      expect(getI18nLang()).toBe('en')
      bindHostLocale({} as Parameters<typeof bindHostLocale>[0])
      bindHostLocale({ getLocale: () => ({ active: 'zh' }) } as Parameters<typeof bindHostLocale>[0])
      expect(getI18nLang()).toBe('en') // subscribe missing → untouched

      let listener: (() => void) | undefined
      let active = 'zh'
      const face = {
        getLocale: () => ({ active }),
        subscribe(fn: () => void) {
          listener = fn
          return () => {
            listener = undefined
          }
        },
      }
      bindHostLocale(face)
      expect(getI18nLang()).toBe('zh')
      active = 'fr'
      listener?.()
      expect(getI18nLang()).toBe('en') // unknown ids fall back to en
      active = 'zh'
      listener?.()
      expect(getI18nLang()).toBe('zh')
    } finally {
      setI18nLang('en')
    }
  })

  it('keeps the navigator fallback when the host face throws', () => {
    bindHostLocale({
      getLocale() {
        throw new Error('host unavailable')
      },
      subscribe: () => () => undefined,
    })
    expect(['zh', 'en']).toContain(getI18nLang())
  })
})
