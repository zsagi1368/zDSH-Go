// @vitest-environment node
/**
 * CSS contract test: every `css.*` reference in PluginManagerSettingsTab.tsx
 * must have a corresponding rule in PluginManagerSettingsTab.module.css.
 *
 * This catches the W2 regression class — the TSX used `css.actionRow` while the
 * CSS module had no `.actionRow` rule, so the flex item collapsed to ~35px and
 * wrapped to 172px tall. jsdom cannot measure computed layout, so this static
 * analysis is the regression lock. It has already caught a second instance of
 * the same class (`.healthChip`).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const tsxPath = join(here, '../src/client/PluginManagerSettingsTab.tsx')
const cssPath = join(here, '../src/client/PluginManagerSettingsTab.module.css')

const tsxSource = readFileSync(tsxPath, 'utf8')
const cssSource = readFileSync(cssPath, 'utf8')

/**
 * Collect the first capture of every match of `pattern` in `source`.
 *
 * `matchAll` rather than a `lastIndex` loop: the iteration is owned by the
 * iterator, so there is no shared regex state to get wrong, and a capture group
 * that did not participate is simply skipped.
 */
function captureAll(source: string, pattern: RegExp): Set<string> {
  const found = new Set<string>()
  for (const match of source.matchAll(pattern)) {
    const captured = match[1]
    if (captured !== undefined) found.add(captured)
  }
  return found
}

/** Every `css.xxx` name the component references. */
function extractCssReferences(source: string): Set<string> {
  return captureAll(source, /\bcss\.([a-zA-Z][a-zA-Z0-9_-]*)/g)
}

/** Every `.xxx` class selector the stylesheet defines. */
function extractCssClasses(source: string): Set<string> {
  return captureAll(source, /\.([a-zA-Z][a-zA-Z0-9_-]*)/g)
}

describe('PluginManagerSettingsTab CSS contract', () => {
  it('every css.* reference in TSX has a matching rule in module.css', () => {
    const refs = extractCssReferences(tsxSource)
    const classes = extractCssClasses(cssSource)
    const missing = [...refs].filter(name => !classes.has(name))
    expect(missing, `Missing CSS rules for: ${missing.join(', ')}`).toEqual([])
  })

  it('the W2 regression class actionRow has a rule', () => {
    expect(extractCssClasses(cssSource).has('actionRow')).toBe(true)
  })
})
