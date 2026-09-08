/**
 * Audit vocabulary, folds, markers, and the visibility invariant.
 *
 * "Model-visible ⟺ recorded": any text injected into a model conversation
 * carries a stable marker `[autopilot:<event>/<id>]`, and every event flagged
 * as model-visible must have that marker present in the recorded injections.
 * Both directions are mechanically checkable (see `checkVisibility`).
 */
import { AUDIT_EVENTS } from './types.js'
import type {
  AuditEvent,
  AuditEventFor,
  AuditEventName,
  AuditPayloadMap,
} from './types.js'
import type { RandomSource } from './ledger.js'

export const AUDIT_EVENT_NAMES: readonly AuditEventName[] = AUDIT_EVENTS

// ---------------------------------------------------------------------------
// Envelope + ids
// ---------------------------------------------------------------------------

/** Session-log append shape with the ignorable option the host supports. */
export interface IgnorableEnvelope<N extends AuditEventName = AuditEventName> {
  type: N
  data: AuditPayloadMap[N]
  options: { ignorable: true }
}

export function envelope<N extends AuditEventName>(
  name: N,
  data: AuditPayloadMap[N],
): IgnorableEnvelope<N> {
  return { type: name, data, options: { ignorable: true } }
}

export function makeEventId(prefix: string, rng: RandomSource, at: number): string {
  return `${prefix}_${at.toString(36)}_${rng.token()}`
}

export function makeAuditEvent<N extends AuditEventName>(
  name: N,
  data: AuditPayloadMap[N],
  at: number,
  rng: RandomSource,
): AuditEventFor<N> {
  return { name, id: makeEventId(name.replace('/', '_'), rng, at), at, data }
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const MARKER_RE = /\[autopilot:(ap\/[a-z]+)\/([A-Za-z0-9_-]+)\]/g

export function buildMarker(name: AuditEventName, id: string): string {
  return `[autopilot:${name}/${id}]`
}

export interface ParsedMarker {
  event: AuditEventName
  id: string
}

export function parseMarkers(text: string): ParsedMarker[] {
  const out: ParsedMarker[] = []
  for (const match of text.matchAll(MARKER_RE)) {
    const event = match[1] as AuditEventName
    if (!AUDIT_EVENT_NAMES.includes(event)) continue
    out.push({ event, id: match[2] ?? '' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Folds — pure functions from events to queryable state ("replay is state")
// ---------------------------------------------------------------------------

export interface CircuitStateFold {
  tripped: boolean
  action: 'delegate' | 'reject' | 'abort-turn' | undefined
}

export interface GrantStateFold {
  phase: 'issued' | 'consumed' | 'settled' | 'expired'
}

export interface OverrideStateFold {
  toolName: string
  phase: 'issued' | 'consumed' | 'expired'
}

export interface VerdictRecord {
  verdictId: string
  decision: 'allow' | 'deny'
  fallback?: string
}

export interface AuditStateFold {
  enabled: boolean
  counters: Record<AuditEventName, number>
  grants: Record<string, GrantStateFold>
  overrides: Record<string, OverrideStateFold>
  circuit: CircuitStateFold
  lastVerdicts: VerdictRecord[]
}

const VERDICT_CAP = 50

export function initialAuditState(): AuditStateFold {
  const counters = {} as Record<AuditEventName, number>
  for (const name of AUDIT_EVENT_NAMES) counters[name] = 0
  return {
    enabled: true,
    counters,
    grants: {},
    overrides: {},
    circuit: { tripped: false, action: undefined },
    lastVerdicts: [],
  }
}

export function foldAudit(state: AuditStateFold, event: AuditEvent): AuditStateFold {
  const next: AuditStateFold = {
    ...state,
    counters: { ...state.counters, [event.name]: state.counters[event.name] + 1 },
    grants: { ...state.grants },
    overrides: { ...state.overrides },
    lastVerdicts: [...state.lastVerdicts],
  }
  switch (event.name) {
    case 'ap/state':
      next.enabled = event.data.enabled
      break
    case 'ap/grant':
      next.grants[event.data.grantId] = { phase: event.data.phase }
      break
    case 'ap/override':
      next.overrides[event.data.overrideId] = {
        toolName: event.data.toolName,
        phase: event.data.phase,
      }
      break
    case 'ap/circuit':
      // Each ap/circuit event records one trip; resets are expressed by a
      // follow-up state event rather than a synthetic reset here.
      next.circuit = {
        tripped: true,
        action: event.data.action,
      }
      break
    case 'ap/verdict': {
      const record: VerdictRecord = {
        verdictId: event.data.verdictId,
        decision: event.data.decision,
      }
      if (event.data.fallback !== undefined) record.fallback = event.data.fallback
      next.lastVerdicts.push(record)
      if (next.lastVerdicts.length > VERDICT_CAP) next.lastVerdicts.shift()
      break
    }
    case 'ap/resumed':
    case 'ap/skipped':
    case 'ap/loop':
    case 'ap/decision':
      break
    default:
      break
  }
  return next
}

// ---------------------------------------------------------------------------
// Visibility invariant
// ---------------------------------------------------------------------------

export interface VisibilityReport {
  /** Markers present in injected text but no matching visible event was logged. */
  markersWithoutEvents: ParsedMarker[]
  /** Visible events were logged but their marker never appeared in any text. */
  eventsWithoutMarkers: AuditEventName[]
}

/**
 * Two-directional check between injected texts and the audit stream. Only
 * events whose payload produced model-visible text participate; payloads mark
 * this via an accompanying `visible` list supplied by the caller.
 */
export function checkVisibility(
  injectedTexts: readonly string[],
  events: readonly AuditEvent[],
  visibleEventIds: ReadonlySet<string>,
): VisibilityReport {
  const recordedIds = new Set(events.map(e => e.id))
  const markersWithoutEvents: ParsedMarker[] = []
  for (const text of injectedTexts) {
    for (const marker of parseMarkers(text)) {
      const key = `${marker.event}#${marker.id}`
      if (!recordedIds.has(marker.id) && !visibleEventIds.has(key)) {
        // Unknown marker format or missing event — both directions report.
        markersWithoutEvents.push(marker)
      }
    }
  }

  const allText = injectedTexts.join('\n')
  const eventsWithoutMarkers: AuditEventName[] = []
  for (const event of events) {
    if (!visibleEventIds.has(`${event.name}#${event.id}`)) continue
    if (!allText.includes(buildMarker(event.name, event.id))) {
      eventsWithoutMarkers.push(event.name)
    }
  }
  return { markersWithoutEvents, eventsWithoutMarkers }
}
