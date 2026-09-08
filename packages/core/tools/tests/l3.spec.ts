import { describe, expect, it } from 'vitest'
import { PRUNING_META_KEY, pruningFromMeta, pruningMeta, toolCapToByteLimit } from '../src/l3.ts'

describe('ToolResultPruning metadata', () => {
  it('builds a frozen pruning declaration', () => {
    const decl = pruningMeta(true, 4096)
    expect(decl.prunable).toBe(true)
    expect(decl.bytes).toBe(4096)
    expect(Object.isFrozen(decl)).toBe(true)
  })

  it('can be stored and retrieved from a meta payload', () => {
    const decl = pruningMeta(false, 2048)
    const meta = { [PRUNING_META_KEY]: decl }
    const retrieved = pruningFromMeta(meta)
    expect(retrieved).toBeDefined()
    expect(retrieved!.prunable).toBe(false)
    expect(retrieved!.bytes).toBe(2048)
  })

  it('returns undefined for absent or malformed meta', () => {
    expect(pruningFromMeta(undefined)).toBeUndefined()
    expect(pruningFromMeta(null)).toBeUndefined()
    expect(pruningFromMeta('string')).toBeUndefined()
    expect(pruningFromMeta(42)).toBeUndefined()
    expect(pruningFromMeta({})).toBeUndefined()
    // Wrong key.
    expect(pruningFromMeta({ other: { prunable: true, bytes: 100 } })).toBeUndefined()
    // Missing fields.
    expect(pruningFromMeta({ [PRUNING_META_KEY]: { prunable: true } })).toBeUndefined()
    // Wrong types.
    expect(pruningFromMeta({ [PRUNING_META_KEY]: { prunable: 'yes', bytes: 100 } })).toBeUndefined()
    // Negative bytes.
    expect(pruningFromMeta({ [PRUNING_META_KEY]: { prunable: true, bytes: -1 } })).toBeUndefined()
  })
})

describe('toolCapToByteLimit', () => {
  it('computes the UTF-8 byte limit from a toolCap token count', () => {
    // toolCap 1228 (32k window) → 1228 × 3.5 = 4298.
    expect(toolCapToByteLimit(1228)).toBe(4298)
    // toolCap 5120 (1M/cap64k) → 5120 × 3.5 = 17920.
    expect(toolCapToByteLimit(5120)).toBe(17920)
    // Floor of 3 × 3.5 = 10.5 → 10.
    expect(toolCapToByteLimit(3)).toBe(10)
  })

  it('has a minimum of 1', () => {
    expect(toolCapToByteLimit(0)).toBe(1)
    expect(toolCapToByteLimit(-1)).toBe(1)
  })
})
