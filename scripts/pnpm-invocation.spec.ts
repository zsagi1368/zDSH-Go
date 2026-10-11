import { describe, expect, it } from 'vitest'
import { pnpmInvocation, type DetectedPnpm } from './pnpm-invocation.ts'

describe('pnpm invocation', () => {
  it.each([
    '/tools/pnpm.js',
    '/tools/pnpm.cjs',
    '/tools/pnpm.mjs',
    '/tools/PNPM.CJS',
    '/tools/with spaces/工具/$pnpm;/pnpm.mjs',
  ])('runs the JavaScript entrypoint %j through Node', (entrypoint) => {
    expect(pnpmInvocation(['run', 'build'], { npm_execpath: entrypoint })).toEqual({
      command: process.execPath,
      args: [entrypoint, 'run', 'build'],
    })
  })

  it.each([
    '/tools/pnpm',
    '/tools/with spaces/$pnpm;/pnpm',
    String.raw`C:\Program Files\工具\$pnpm;\pnpm.exe`,
  ])('runs the executable entrypoint %j directly', (entrypoint) => {
    expect(pnpmInvocation(['run', 'build'], { npm_execpath: entrypoint })).toEqual({
      command: entrypoint,
      args: ['run', 'build'],
    })
  })

  it.each([
    { npm_execpath: undefined },
    { npm_execpath: '' },
    { npm_execpath: '/tools/npm-cli.js' },
    { npm_execpath: '/tools/yarn.js' },
  ])('resolves a detected entrypoint pnpm when npm_execpath is $npm_execpath instead of misusing another manager', (environment) => {
    const detect = (): DetectedPnpm => ({ kind: 'entrypoint', path: '/detected/pnpm.cjs' })
    expect(pnpmInvocation(['run', 'build'], environment, detect)).toEqual({
      command: process.execPath,
      args: ['/detected/pnpm.cjs', 'run', 'build'],
    })
  })

  it('resolves a detected command pnpm directly', () => {
    const detect = (): DetectedPnpm => ({ kind: 'command', path: '/detected/pnpm' })
    expect(pnpmInvocation(['exec', 'vitest'], { npm_execpath: '/tools/npm-cli.js' }, detect)).toEqual({
      command: '/detected/pnpm',
      args: ['exec', 'vitest'],
    })
  })

  it('surfaces detection guidance instead of falling back to a non-pnpm entrypoint', () => {
    const detect = (): DetectedPnpm => {
      throw new Error('pnpm invocation: no usable pnpm detected via scripts/run-healthy-spec.mjs: install a matching pnpm')
    }
    expect(() => pnpmInvocation([], { npm_execpath: '/tools/npm-cli.js' }, detect))
      .toThrow('no usable pnpm detected via scripts/run-healthy-spec.mjs')
  })
})
