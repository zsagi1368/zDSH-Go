/**
 * Discovery suite (S-43 M1): symlink/junction exclusion (A-04), manifest
 * tolerance (A-05), and the no-YAML construction property (A-06).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverProjectPlugins } from '../src/discover.ts'
import { manifestBlob, writePluginPackage, createPluginJunction, tempDir } from './fixtures.ts'

const roots: string[] = []
const warns: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  warns.length = 0
})

function makeRoot(): string {
  const root = tempDir()
  roots.push(root)
  return root
}

const warn = (message: string) => void warns.push(message)

describe('discoverProjectPlugins', () => {
  it('finds the project root by walking up from cwd and returns directory-order candidates', () => {
    const root = makeRoot()
    mkdirSync(join(root, '.git'))
    writePluginPackage(root, 'demo', manifestBlob())
    writePluginPackage(root, 'other', manifestBlob({ id: 'fixtures/other', name: 'Other' }))
    const cwd = join(root, 'src')
    mkdirSync(cwd, { recursive: true })
    const candidates = discoverProjectPlugins(cwd, { warn })
    expect(candidates.map(c => c.id).sort()).toEqual(['fixtures/demo', 'fixtures/other'])
    for (const candidate of candidates) {
      expect(candidate.projectRoot).toBe(root)
      expect(candidate.pluginDir).toBe(join(root, '.dsh', 'plugins', candidate.id.split('/')[1]!))
      expect(candidate.manifestHash).toMatch(/^[0-9a-f]{64}$/)
      expect(candidate.entryFile).toBe(join(candidate.pluginDir, 'index.js'))
      expect(candidate.source).toBe('project')
    }
    expect(warns).toEqual([])
  })

  it('returns nothing (no warning) when there is no plugin root at all', () => {
    const root = makeRoot()
    expect(discoverProjectPlugins(root, { warn })).toEqual([])
    expect(warns).toEqual([])
  })

  it('excludes a symlink/junction plugin entry with a warn naming the path (A-04)', () => {
    const root = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-ppr-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'index.js'), 'export default class {}')
    writeFileSync(join(outside, 'manifest.json'), JSON.stringify(manifestBlob()))
    createPluginJunction(root, 'evil', outside)
    const candidates = discoverProjectPlugins(root, { warn })
    expect(candidates).toEqual([])
    expect(warns.some(line => line.includes(join(root, '.dsh', 'plugins', 'evil')))).toBe(true)
    expect(warns.some(line => line.includes('symbolic links or junctions'))).toBe(true)
  })

  it('rejects a symlinked manifest or entry file inside an otherwise real plugin dir (A-04)', () => {
    const root = makeRoot()
    const pluginDir = writePluginPackage(root, 'demo', manifestBlob())
    const outside = mkdtempSync(join(tmpdir(), 'dsh-ppr-outside2-'))
    roots.push(outside)
    writeFileSync(join(outside, 'manifest.json'), JSON.stringify(manifestBlob()))
    // Replace the real manifest with a junction to the outside copy.
    rmSync(join(pluginDir, 'manifest.json'))
    try {
      symlinkSync(join(outside, 'manifest.json'), join(pluginDir, 'manifest.json'), 'junction')
    } catch {
      return // Platform does not support junction creation; skip.
    }
    const candidates = discoverProjectPlugins(root, { warn })
    expect(candidates).toEqual([])
    expect(warns.some(line => line.includes('must not be a symbolic link'))).toBe(true)
  })

  it('skips a manifest that is not valid JSON with a warn naming the path (A-05)', () => {
    const root = makeRoot()
    const pluginDir = writePluginPackage(root, 'demo', manifestBlob())
    writeFileSync(join(pluginDir, 'manifest.json'), '{ not json !!js')
    const candidates = discoverProjectPlugins(root, { warn })
    expect(candidates).toEqual([])
    expect(warns.some(line => line.includes(pluginDir) && line.includes('not valid JSON'))).toBe(true)
  })

  it('skips a manifest missing required fields with a warn naming the fields (A-05)', () => {
    const root = makeRoot()
    writePluginPackage(root, 'demo', { id: 'fixtures/demo', version: '1.0.0' })
    const candidates = discoverProjectPlugins(root, { warn })
    expect(candidates).toEqual([])
    expect(warns.some(line => line.includes('missing required field'))).toBe(true)
    expect(warns.some(line => line.includes('capabilities') && line.includes('sandbox'))).toBe(true)
  })

  it('skips an invalid plugin id with a warn', () => {
    const root = makeRoot()
    writePluginPackage(root, 'demo', manifestBlob({ id: 'not-a-valid id!' }))
    const candidates = discoverProjectPlugins(root, { warn })
    expect(candidates).toEqual([])
    expect(warns.some(line => line.includes('does not normalize to a valid plugin id'))).toBe(true)
  })

  it('skips a package without an entry module', () => {
    const root = makeRoot()
    const pluginDir = writePluginPackage(root, 'demo', manifestBlob())
    rmSync(join(pluginDir, 'index.js'))
    const candidates = discoverProjectPlugins(root, { warn })
    expect(candidates).toEqual([])
    expect(warns.some(line => line.includes('entry module index.js is missing'))).toBe(true)
  })

  it('constructs candidates as plain objects — no YAML serialization anywhere (A-06)', () => {
    const root = makeRoot()
    // Fuzz every string field with `!!js` expression shapes (A7.4): if any
    // discovery step serialized these through YAML, the expression tags would
    // be interpreted later. Discovery must carry them as inert strings.
    const fuzz = '!!js "process.exit(1)"'
    const manifest = manifestBlob({
      id: 'fixtures/demo',
      name: fuzz,
      version: '1.0.0',
      dsh: { compatible: `>=0.1.0-rc.8 ${fuzz}` },
      capabilities: [
        { type: 'tool', tool: { name: `${fuzz}_tool`, description: fuzz, schema: { type: 'object' } } },
      ],
    })
    writePluginPackage(root, 'demo', manifest)
    const candidates = discoverProjectPlugins(root, { warn })
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    // The raw fuzz strings survive verbatim as object fields.
    expect(candidate.name).toBe(fuzz)
    expect(candidate.manifest.capabilities[0]?.tool?.description).toBe(fuzz)
    // The candidate is the exact object the mount path hands to the Loader —
    // there is no intermediate YAML text (A-06: nothing to dump, nothing to parse).
    expect(JSON.stringify(candidate)).not.toContain('yaml')
  })

  it('realpaths the plugin directory so an internal junction cannot widen the clamp', () => {
    const root = makeRoot()
    const realDir = writePluginPackage(root, 'demo', manifestBlob())
    // Re-point the plugins/demo dir to a junction target inside the root that
    // itself is not under .dsh/plugins.
    rmSync(realDir, { recursive: true })
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'manifest.json'), JSON.stringify(manifestBlob()))
    writeFileSync(join(elsewhere, 'index.js'), 'export default class {}')
    createPluginJunction(root, 'demo', elsewhere)
    const candidates = discoverProjectPlugins(root, { warn })
    // The junction entry itself is rejected (A-04) — never followed.
    expect(candidates).toEqual([])
  })
})
