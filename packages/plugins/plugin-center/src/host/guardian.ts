/**
 * Node self-guardian: a detached watchdog that keeps the DSH host reachable.
 *
 * Unlike OS-service guardians this needs no launchd/schtasks/systemd — it is
 * an ordinary detached child process. It probes a fixed loopback address
 * (hardcoded, never a configurable hostname), applies the shared bounded
 * restart budget, and records its status under `<dataRoot>/guardian/`.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface GuardianConfig {
  dataRoot: string
  /** TCP port of the DSH web host on 127.0.0.1. */
  port: number
  /** Command that boots the DSH web host again after a crash. */
  launch: { cmd: string; args: string[] }
  intervalMs?: number
}

export interface GuardianStatus {
  state: 'probing' | 'restarting' | 'healthy' | 'give-up'
  bootId: string
  startedAtMs: number
  checkedAtMs: number
  healthyTicks: number
  restartsUsed: number
}

export function guardianDir(dataRoot: string): string {
  return join(dataRoot, 'guardian')
}

export function statusPath(dataRoot: string): string {
  return join(guardianDir(dataRoot), 'status.json')
}

export function pidPath(dataRoot: string): string {
  return join(guardianDir(dataRoot), 'pid.txt')
}

/** Resolve the built guardian entrypoint next to this module. */
export function guardianEntryPath(): string {
  for (const candidate of ['../guardian-entry.js', '../../lib/guardian-entry.js']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }
  throw new Error('guardian entry not found next to guardian.js')
}

/** Fixed two-argument invocation of the entry script (no shell involved). */
function watchdogArgs(entry: string, cfgFile: string): string[] {
  return [entry, '--config', cfgFile]
}

interface PidResult {
  ok: boolean
  pid?: number
  reason?: string
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Spawn the detached watchdog; resolves with its pid. Idempotent per pidfile. */
export async function startGuardian(config: GuardianConfig): Promise<PidResult> {
  const dir = guardianDir(config.dataRoot)
  const pidFile = pidPath(config.dataRoot)
  if (existsSync(pidFile)) {
    const existing = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    if (Number.isFinite(existing) && isAlive(existing)) {
      return { ok: true, pid: existing, reason: 'already-running' }
    }
  }
  const cfgFile = join(dir, 'config.json')
  const configBytes = JSON.stringify(config)
  writeFileSync(cfgFile, configBytes, 'utf8')
  // Integrity sidecar: the entry refuses a tampered config, so a write-only
  // primitive cannot escalate into arbitrary relaunch commands.
  const digest = createHash('sha256').update(configBytes, 'utf8').digest('hex')
  writeFileSync(`${cfgFile}.sha256`, digest, 'utf8')
  const result = await import('node:child_process').then(
    ({ spawn }) => {
      // Same argument-list shape as ports.runViaSpawn; no shell anywhere.
      const child = spawn(process.execPath, watchdogArgs(guardianEntryPath(), cfgFile), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      })
      child.unref()
      if (typeof child.pid !== 'number') {
        return { ok: false, reason: 'watchdog-start-failed' }
      }
      writeFileSync(pidFile, String(child.pid), 'utf8')
      return { ok: true, pid: child.pid }
    },
    () => ({ ok: false, reason: 'watchdog-unavailable' }),
  )
  return result
}

/** Stop a running watchdog; safe when none is running. */
export function stopGuardian(dataRoot: string): { stopped: boolean } {
  const pidFile = pidPath(dataRoot)
  if (!existsSync(pidFile)) return { stopped: false }
  const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
  try {
    if (Number.isFinite(pid)) process.kill(pid)
  } catch {
    // already gone
  }
  try {
    unlinkSync(pidFile)
  } catch {
    // best effort
  }
  return { stopped: true }
}
