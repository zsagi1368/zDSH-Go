// @vitest-environment node
/**
 * CSS contract test: every `css.*` reference in PluginManagerSettingsTab.tsx
 * must have a corresponding rule in PluginManagerSettingsTab.module.css.
 *
 * This catches the W2 regression class — TSX used `css.actionRow` but the CSS
 * module had no `.actionRow` rule, so the flex item collapsed. jsdom cannot
 * measure computed layout, so this static analysis is the regression lock.
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

/** Extract every `css.xxx` reference from the TSX source. */
function extractCssReferences(source: string): Set<string> {
  const refs = new Set<string>()
  const re = /\bcss\.([a-zA-Z][a-zA-Z0-9_-]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    refs.add(m[1])
  }
  return refs
}

/** Extract every `.xxx` class selector from the CSS source. */
function extractCssClasses(source: string): Set<string> {
  const classes = new Set<string>()
  const re = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    classes.add(m[1])
  }
  return classes
}

describe('PluginManagerSettingsTab CSS contract', () => {
  it('every css.* reference in TSX has a matching rule in module.css', () => {
    const refs = extractCssReferences(tsxSource)
    const classes = extractCssClasses(cssSource)
    const missing = [...refs].filter(name => !classes.has(name))
    expect(missing, `Missing CSS rules for: ${missing.join(', ')}`).toEqual([])
  })

  it('the W2 regression class actionRow has a rule', () => {
    const classes = extractCssClasses(cssSource)
    expect(classes.has('actionRow')).toBe(true)
  })
})
