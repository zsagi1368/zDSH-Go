import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/index.js'

describe('loader contract', () => {
  it('exposes the plugin name', () => {
    expect(name).toBe('@deepseek-ai/dsh-autopilot')
  })

  it('exports an apply function', () => {
    expect(typeof apply).toBe('function')
    expect(() => apply({})).not.toThrow()
  })
})
