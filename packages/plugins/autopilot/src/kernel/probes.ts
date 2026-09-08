/**
 * Three-level capability probing.
 *
 * Every assumption about a host seam is REGISTERED here with a description and
 * an optional probe. Before a seam is relied upon:
 *   level 1 — precheck (version / shape inspection, cheap, no side effects)
 *   level 2 — first-call probe (a real but harmless call through the seam)
 *   level 3 — degradation flag (fall back to the in-memory equivalent path)
 *
 * Probe results are cached; modules query instead of assuming. Each entry's
 * comment names its regression test.
 */

export interface ProbeResult {
  ok: boolean
  degraded: boolean
  detail?: string
}

export interface Assumption {
  id: string
  /** What we assume about the host, phrased as a falsifiable statement. */
  description: string
  /** Level-1 precheck; when absent the probe runs directly. */
  precheck?: () => boolean | string
  /** Level-2 first-call probe; returns detail on failure. */
  probe?: () => true | string
}

export interface AssumptionStatus {
  id: string
  state: 'unprobed' | 'available' | 'degraded' | 'unavailable'
  detail?: string
}

export class ProbeRegistry {
  private assumptions = new Map<string, Assumption>()
  private statuses = new Map<string, AssumptionStatus>()

  register(assumption: Assumption): void {
    this.assumptions.set(assumption.id, assumption)
    if (!this.statuses.has(assumption.id)) {
      this.statuses.set(assumption.id, { id: assumption.id, state: 'unprobed' })
    }
  }

  /**
   * Run the three-level flow for one assumption and cache the verdict.
   * Safe to call repeatedly; only the first run performs work.
   */
  probe(id: string): AssumptionStatus {
    const cached = this.statuses.get(id)
    if (cached && cached.state !== 'unprobed') return cached

    const assumption = this.assumptions.get(id)
    if (!assumption) {
      const status: AssumptionStatus = { id, state: 'unavailable', detail: 'unknown assumption' }
      this.statuses.set(id, status)
      return status
    }

    if (assumption.precheck) {
      let precheck: boolean | string
      try {
        precheck = assumption.precheck()
      } catch (error) {
        precheck = error instanceof Error ? error.message : String(error)
      }
      if (precheck !== true) {
        const status: AssumptionStatus = {
          id,
          state: 'degraded',
          detail: `precheck failed${typeof precheck === 'string' ? `: ${precheck}` : ''}`,
        }
        this.statuses.set(id, status)
        return status
      }
    }

    if (!assumption.probe) {
      const status: AssumptionStatus = { id, state: 'available' }
      this.statuses.set(id, status)
      return status
    }

    let probeResult: true | string
    try {
      probeResult = assumption.probe()
    } catch (error) {
      probeResult = error instanceof Error ? error.message : String(error)
    }
    const status: AssumptionStatus =
      probeResult === true
        ? { id, state: 'available' }
        : { id, state: 'degraded', detail: probeResult }
    this.statuses.set(id, status)
    return status
  }

  status(id: string): AssumptionStatus {
    return (
      this.statuses.get(id) ?? { id, state: 'unavailable', detail: 'not registered' }
    )
  }

  all(): AssumptionStatus[] {
    return [...this.statuses.values()]
  }
}
