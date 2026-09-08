/**
 * Kernel facade — THE frozen boundary between the kernel and capability
 * modules.
 *
 * Facade rule (CI-enforced): modules under src/{continue,guard,review,console}
 * may import ONLY this file's exports and their own directory. The kernel
 * never imports upward.
 */
import { AutomationCoordinator } from './coordinator.js'
import { LedgerHub, StatsCounters, createTokenSource } from './ledger.js'
import type { BackoffParams, Clock, RandomSource, StatsPersistence } from './ledger.js'
import { ProbeRegistry } from './probes.js'
import { DEFAULTS, resolveConfig } from './defaults.js'
import type { ResolvedDefaults } from './defaults.js'
import type { ModuleId } from './types.js'

export interface KernelPorts {
  clock?: Clock
  rng?: RandomSource
  /** Optional synchronous snapshot persistence for stats. */
  statsPersistence?: StatsPersistence
}

export interface Kernel {
  readonly coordinator: AutomationCoordinator
  readonly ledger: LedgerHub
  readonly probes: ProbeRegistry
  readonly clock: Clock
  readonly rng: RandomSource
  /** Current resolved configuration (re-resolved on setConfig). */
  config(): ResolvedDefaults
  setConfig(userPatch: Record<string, unknown>): ResolvedDefaults
}

// ---------------------------------------------------------------------------
// Frozen module starter contracts (implemented by M2/M3/M4)
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void
}

export type ContinueOptions = ResolvedDefaults['continue']
export type GuardOptions = ResolvedDefaults['guard']
export type ReviewOptions = ResolvedDefaults['review']

export type ContinueModuleStarter = (kernel: Kernel, options: ContinueOptions) => Disposable
export type GuardModuleStarter = (kernel: Kernel, options: GuardOptions) => Disposable
export type ReviewModuleStarter = (kernel: Kernel, options: ReviewOptions) => Disposable

/** Modules mounted by the composition root, keyed for lifecycle control. */
export interface MountedModules {
  continue?: Disposable
  guard?: Disposable
  review?: Disposable
}

export function createKernel(ports: KernelPorts = {}): Kernel {
  const clock: Clock = ports.clock ?? { now: () => Date.now() }
  const rng: RandomSource = ports.rng ?? createTokenSource()

  let resolved: ResolvedDefaults = resolveConfig(DEFAULTS, {})

  const stats = new StatsCounters(clock, ports.statsPersistence?.load())
  const ledger = new LedgerHub(stats)
  const probes = new ProbeRegistry()
  const coordinator = new AutomationCoordinator()

  return {
    coordinator,
    ledger,
    probes,
    clock,
    rng,
    config: () => resolved,
    setConfig(userPatch) {
      resolved = resolveConfig(DEFAULTS, userPatch)
      return resolved
    },
  }
}

export function defaultBackoffParams(resolved: ResolvedDefaults): BackoffParams {
  return {
    baseMs: resolved.continue.cooldownMs,
    factor: resolved.continue.backoffFactor,
    capMs: resolved.continue.backoffCapMs,
  }
}

export function moduleEnabled(resolved: ResolvedDefaults, moduleId: ModuleId): boolean {
  switch (moduleId) {
    case 'continue':
      return resolved.continue.enabled
    case 'guard':
      return resolved.guard.enabled
    case 'review':
      return resolved.review.enabled
    default:
      return false
  }
}
