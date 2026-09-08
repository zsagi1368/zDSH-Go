/**
 * Console state port implementation + status bridge snapshot.
 *
 * The bridge is host-agnostic: the composition root registers HTTP routes and
 * delegates here. `authorizeAction` is the security boundary — cross-origin
 * or unauthenticated requests MUST be rejected by the adapter before reaching
 * performAction.
 */
import type { ModuleId } from '../kernel/types.js'
import type { ConsoleStatePort, PresetName } from './commands.js'

// ---------------------------------------------------------------------------
// Presets (named config sets applied over user settings)
// ---------------------------------------------------------------------------

export const PRESET_PATCHES: Record<PresetName, Record<string, unknown>> = {
  conservative: {
    continue: { enabled: false },
    guard: { enabled: true, classifyFailDenyStreak: 1 },
    review: {
      enabled: true,
      fallbackPolicy: 'delegate',
      circuit: { consecutiveDenials: 3, windowSize: 10, windowDenials: 6, action: 'delegate' },
    },
  },
  standard: {
    continue: { enabled: true },
    guard: { enabled: true },
    review: { enabled: true, fallbackPolicy: 'rejected' },
  },
  fullspeed: {
    continue: { enabled: true, cooldownMs: 10_000, maxConsecutive: 5 },
    guard: { enabled: true, classifyFailDenyStreak: 3 },
    review: { enabled: true, maxReviewsPerTurn: 20, fallbackPolicy: 'rejected' },
  },
}

export interface ConsoleDeps {
  kernel: import('../kernel/facade.js').Kernel
  moduleEnabled(moduleId: ModuleId): boolean
  setModuleEnabled(moduleId: ModuleId, enabled: boolean): void
}

interface RecentAction {
  at: number
  moduleId: ModuleId
  summary: string
}

const RECENT_CAP = 8

export class ConsoleState implements ConsoleStatePort {
  private readonly recent: RecentAction[] = []
  private latestDenial: { toolName: string; sessionId: string; at: number } | undefined
  paused = false

  constructor(private readonly deps: ConsoleDeps) {}

  note(moduleId: ModuleId, summary: string): void {
    this.recent.push({ at: this.deps.kernel.clock.now(), moduleId, summary })
    if (this.recent.length > RECENT_CAP) this.recent.shift()
  }

  noteDenial(toolName: string, sessionId: string): void {
    this.latestDenial = { toolName, sessionId, at: this.deps.kernel.clock.now() }
    this.note('review', `denied ${toolName}`)
  }

  status() {
    const stats = this.deps.kernel.ledger.statsCounters
    const coordinator = this.deps.kernel.coordinator
    return {
      paused: coordinator.paused,
      circuitOpen: coordinator.circuitOpen,
      modules: {
        continue: this.deps.moduleEnabled('continue'),
        guard: this.deps.moduleEnabled('guard'),
        review: this.deps.moduleEnabled('review'),
      },
      today: {
        sent: stats.get('sent', 'today'),
        skipped: stats.get('skipped', 'today'),
        allowed: stats.get('allowed', 'today'),
        denied: stats.get('denied', 'today'),
        reviewed: stats.get('reviewed', 'today'),
      },
    }
  }

  setModuleEnabled(moduleId: ModuleId, enabled: boolean): void {
    this.deps.setModuleEnabled(moduleId, enabled)
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    this.deps.kernel.coordinator.dispatch({ kind: 'pause-change', paused })
  }

  approveLatestDenial(): { ok: true; toolName: string } | { ok: false } {
    if (!this.latestDenial) return { ok: false }
    const tool = this.latestDenial.toolName
    void tool
    // Actual approval bridging is performed by the review module's
    // approveNext via the composition-root closure; here we only validate.
    return { ok: true, toolName: this.latestDenial.toolName }
  }

  applyPreset(name: PresetName): void {
    this.deps.kernel.setConfig(PRESET_PATCHES[name])
    for (const m of ['continue', 'guard', 'review'] as ModuleId[]) {
      this.deps.setModuleEnabled(m, this.deps.moduleEnabled(m))
    }
  }

  resetStats(): void {
    this.deps.kernel.ledger.statsCounters.reset()
  }

  recentActions(): Array<{ moduleId: ModuleId; summary: string }> {
    return this.recent.map(r => ({ moduleId: r.moduleId, summary: r.summary }))
  }
}

// ---------------------------------------------------------------------------
// Action endpoint payload contract
// ---------------------------------------------------------------------------

export type BridgeAction =
  | { action: 'resume'; sessionId?: string }
  | { action: 'pause1h'; sessionId?: string }
  | { action: 'unpause'; sessionId?: string }
  | { action: 'approve-latest' }
  | { action: 'reset-stats' }

export interface BridgeSnapshot {
  version: 1
  paused: boolean
  circuitOpen: boolean
  modules: Record<ModuleId, boolean>
  today: Record<string, number>
  recent: Array<{ moduleId: ModuleId; summary: string }>
}

/** Security gate — implement in the composition root with real origin checks. */
export type ActionAuthorizer = (payload: unknown) => boolean

/** Minimal surface the action endpoint touches on console state. */
export interface BridgeStateTarget {
  setPaused(paused: boolean): void
  resetStats(): void
}

export function performBridgeAction(
  payload: unknown,
  state: BridgeStateTarget,
  authorize: ActionAuthorizer,
  hooks: {
    resumeSession(sessionId: string): void
    pauseSession(sessionId: string, ms: number): void
    approveLatest(): boolean
  },
): { ok: boolean; error?: string } {
  if (!authorize(payload)) return { ok: false, error: 'unauthorized' }
  const MAX_BODY_CHARS = 4096
  if (typeof payload === 'string' && payload.length > MAX_BODY_CHARS) {
    return { ok: false, error: 'payload too large' }
  }
  let parsed: BridgeAction
  try {
    parsed = typeof payload === 'string' ? (JSON.parse(payload) as BridgeAction) : (payload as BridgeAction)
  } catch {
    return { ok: false, error: 'bad json' }
  }
  switch (parsed.action) {
    case 'resume':
      if (parsed.sessionId) hooks.resumeSession(parsed.sessionId)
      state.setPaused(false)
      return { ok: true }
    case 'unpause':
      state.setPaused(false)
      return { ok: true }
    case 'pause1h':
      state.setPaused(true)
      if (parsed.sessionId) hooks.pauseSession(parsed.sessionId, 3_600_000)
      return { ok: true }
    case 'approve-latest':
      return { ok: hooks.approveLatest() }
    case 'reset-stats':
      state.resetStats()
      return { ok: true }
    default:
      return { ok: false, error: 'unknown action' }
  }
}
