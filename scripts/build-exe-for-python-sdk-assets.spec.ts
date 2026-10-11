import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const script = resolve(root, 'scripts/build-exe-for-python-sdk.ts')

describe('Python runtime executable assets', () => {
  it('packages the dynamically resolved web frontend distribution', () => {
    // TC-B4-S2d: the env override must be deterministic on Windows — a vitest
    // worker can carry the case-variant `NPM_EXECPATH` (npm-cli.js), and the
    // case-insensitive child env block would let it shadow the lowercase
    // override, silently feeding the script an npm entrypoint (which the
    // S2d shared trust model now honestly rejects instead of blind-trusting).
    const env: NodeJS.ProcessEnv = { ...process.env, npm_execpath: 'C:\\tools\\pnpm.cjs' }
    delete env.NPM_EXECPATH
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx/esm',
      script,
      '--skip-build',
      '--dry-run',
      '--targets=node24-macos-arm64',
    ], {
      cwd: root,
      encoding: 'utf8',
      env,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('node_modules/@deepseek-ai/dsh-web-frontend/dist/**/*')
    expect(result.stdout).toContain('node_modules/@deepseek-ai/dsh-*/**/*.{svg,png,jpg,jpeg,webp}')
    expect(result.stdout).not.toContain('skill-badge/assets/**/*')
    expect(result.stdout).toContain('node_modules/@deepseek-ai/dsh-sandbox-windows-acl/assets/**/*')
    expect(result.stdout).not.toContain('node_modules/**/*.py')
  })
})
