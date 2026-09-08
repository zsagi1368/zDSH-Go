/**
 * Watchdog entrypoint (`node lib/guardian-entry.js --config <file>`).
 *
 * Runs detached from the DSH host. Every tick it probes a hardcoded loopback
 * address on the configured port; sustained failure triggers a bounded
 * relaunch of the host command. Status is mirrored to disk each tick so the
 * plugin surface can report what the watchdog sees.
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { GuardianConfig, GuardianStatus } from './guardian.js'
import { decideAction, RestartBudget } from './restart-budget.js'

const LOOPBACK_HOST = '127.0.0.1' // fixed: the watchdog never targets other hosts

function argAfter(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  return index >= 0 ? (argv[index + 1] ?? null) : null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

/**
 * Contained path helper: watchdog artifacts must resolve strictly inside the
 * data root. After normalization any escaping candidate loses the root
 * prefix, so a strict prefix comparison suffices on drive-letter and POSIX
 * layouts alike.
 */
export function containedUnderRoot(dataRoot: string, ...segments: string[]): string {
  const root = resolve(dataRoot)
  const file = resolve(join(root, ...segments))
  const inside = isAbsolute(file) && file.startsWith(root + sep) && file !== root
  if (!inside) throw new Error('watchdog path escaped the data root')
  return file
}

function statusFileFor(dataRoot: string): string {
  return containedUnderRoot(dataRoot, 'guardian', 'status.json')
}

/** Validate the operator-supplied config path before any IO touches it. */
export function validatedConfigPath(raw: string): string {
  const resolved = resolve(raw)
  const parentDir = resolve(resolved, sep)
  const sane = isAbsolute(resolved) && resolved !== parentDir && existsSync(resolved)
  if (!sane) throw new Error('--config must point to an existing absolute file')
  return resolved
}

/**
 * Load the watchdog config and verify its sha256 sidecar. A config that was
 * tampered with after startGuardian wrote it is refused outright, so write
 * access to the data root alone cannot plant a relaunch command.
 */
async function loadConfig(rawPath: string): Promise<GuardianConfig> {
  const cfgPath = validatedConfigPath(rawPath)
  const [text, expectedDigest] = await Promise.all([
    readFile(cfgPath, 'utf8'),
    readFile(`${cfgPath}.sha256`, 'utf8').catch(() => null),
  ])
  if (expectedDigest === null) throw new Error('watchdog config is missing its integrity sidecar')
  const actualDigest = createHash('sha256').update(text, 'utf8').digest('hex')
  if (actualDigest !== expectedDigest.trim()) {
    throw new Error('watchdog config failed integrity verification')
  }
  return JSON.parse(text) as GuardianConfig
}

/** Probe the local web host; any HTTP response under 500 counts as alive. */
export async function probeLoopback(port: number, timeoutMs = 2500): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    try {
      const response = await fetch(`http://${LOOPBACK_HOST}:${String(port)}/`, {
        signal: controller.signal,
      })
      return response.status < 500
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

interface LaunchSpec {
  cmd: string
  args: string[]
}

/** Boot the host command again as its own detached process (no shell). */
export async function relaunchHost(launch: LaunchSpec): Promise<number | null> {
  return import('node:child_process').then(
    ({ spawn }) => {
      // Argument-list form straight from the validated config object.
      const child = spawn(launch.cmd, launch.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      })
      child.unref()
      return typeof child.pid === 'number' ? child.pid : null
    },
    () => null,
  )
}

export class Watchdog {
  private readonly budget = new RestartBudget()
  private readonly bootId = randomUUID()
  private healthyTicks = 0
  private readonly startedAtMs = Date.now()

  constructor(
    private readonly config: GuardianConfig,
    private readonly persist: (status: GuardianStatus) => void,
  ) {}

  private base(): Omit<GuardianStatus, 'state'> {
    return {
      bootId: this.bootId,
      startedAtMs: this.startedAtMs,
      checkedAtMs: Date.now(),
      healthyTicks: this.healthyTicks,
      restartsUsed: this.budget.used(Date.now()),
    }
  }

  async tick(nowMs: number): Promise<GuardianStatus['state'] | 'exit'> {
    const healthy = await probeLoopback(this.config.port)
    if (healthy) {
      this.healthyTicks += 1
      const state: GuardianStatus['state'] = this.healthyTicks >= 3 ? 'healthy' : 'probing'
      this.persist({ ...this.base(), state })
      return state
    }
    this.healthyTicks = 0
    const action = decideAction({ verdict: { kind: 'unhealthy' }, budget: this.budget, nowMs })
    if (action === 'give-up') {
      this.persist({ ...this.base(), state: 'give-up' })
      return 'exit'
    }
    this.budget.record(nowMs)
    this.persist({ ...this.base(), state: 'restarting' })
    await relaunchHost(this.config.launch)
    await sleep(15_000) // settle window before judging the fresh host
    return 'restarting'
  }
}

export async function runWatchdog(config: GuardianConfig): Promise<void> {
  mkdirSync(containedUnderRoot(config.dataRoot, 'guardian'), { recursive: true })
  const statusFile = statusFileFor(config.dataRoot)
  const watchdog = new Watchdog(config, (status) => {
    writeFileSync(statusFile, JSON.stringify(status), 'utf8')
  })
  for (;;) {
    const outcome = await watchdog.tick(Date.now())
    if (outcome === 'exit') break
    await sleep(config.intervalMs ?? 3_000)
  }
}

// Auto-run only when invoked directly as the process script.
export function autoRunOnImport(argv: string[], isDirect: boolean): void {
  if (!isDirect) return
  const rawCfg = argAfter(argv, '--config')
  if (!rawCfg) {
    console.error('watchdog requires --config <file>')
    process.exit(2)
  }
  void loadConfig(rawCfg)
    .then(runWatchdog)
    .catch((error: unknown) => {
      console.error('watchdog failed to start:', error instanceof Error ? error.message : error)
      process.exit(1)
    })
}
