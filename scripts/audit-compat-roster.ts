/**
 * zDSH compat roster audit — formal tool (MAIN-HYGIENE, sync-017 DEBT
 * rulings §15).
 *
 * Runs all six zDSH compatibility guards in ONE module graph and dumps the
 * process-level audit roster as single-line machine-greppable evidence.
 *
 * Why this file exists: the previous tooling was a TMP scratch script pair
 * (sync-p2-roster.mts / -roster2.mts) that imported dsh-compat through a
 * `file://` URL while the six guards import it through the BARE specifier
 * `@deepseek-ai/dsh-compat` — Node/tsx resolved those two channels to two
 * distinct dsh-compat module instances, i.e. two independent roster Maps, so
 * the script-side getCompatRoster() silently read an EMPTY bookkeeping (the
 * REVIEW-P2 suggestion-4 "dual module instance empty roster" mechanism). P5/P6
 * worked around it by hand-writing throwaway in-repo specs each round.
 *
 * Single-channel discipline (rulings §15.1): this script imports dsh-compat
 * through the same bare specifier the guards use, and loads the six guards
 * from repo-relative paths (their compat.ts files are not package export
 * faces). `pnpm exec tsx` resolves the bare specifier through the repo
 * tsconfig paths (tsconfig.base.json alias → packages/zdsh/dsh-compat/src),
 * so guards and script provably share ONE module instance. Five host-face
 * guards are static imports; the sixth (client-face ui-settings-models) is a
 * computed-specifier dynamic import — see the boundary note at its call site.
 *
 * Fail-closed self-check (rulings §15.2): the roster must contain exactly the
 * six expected features; anything else throws loudly — the empty-bookkeeping
 * defect can never pass silently again.
 *
 * stdout evidence contract (rulings §15.3; skill P6 command rotation = D1):
 * exactly two single-line records, safe to embed verbatim in progress docs —
 *   COMPAT_ROSTER_JSON: {"<feature>":{"enabled":…,"reason":"…","checkedAt":"…"},…}
 *   DISABLED_LIST: ["<feature>",…]
 * All progress/diagnostic output goes to stderr so stdout stays pure contract.
 *
 * Deliberately NOT a spec (rulings §15.5): scripts/**\/*.spec.ts lands in the
 * main vitest include and would churn the 主口径 baseline count; these
 * assertions are a runtime audit with no regression-lock increment.
 *
 * CI: the zdsh-ci.yml contract-gates lane runs this after the static gates
 * (src-level import graph via tsconfig paths — no build prerequisite).
 *
 * Run: `pnpm exec tsx scripts/audit-compat-roster.ts`
 * (exit 0 = all six guards booked; non-zero = fail-closed breach).
 * @module scripts/audit-compat-roster
 */

import { getCompatRoster } from '@deepseek-ai/dsh-compat'
import type { CompatLogger } from '@deepseek-ai/dsh-compat'
import { guardACP } from '../packages/acp/acp/src/compat.ts'
import { guardTruncatedToolCalls } from '../packages/llm/llm/src/compat.ts'
import { guardModelSlots } from '../packages/llm/model-slots/src/compat.ts'
import { guardGovernance } from '../packages/zdsh/plugin-governance/src/compat.ts'
import { guardProjectRoot } from '../packages/zdsh/plugin-project-root/src/compat.ts'

/** The six guarded zDSH features (roster keys), i.e. the fail-closed expectation. */
export const EXPECTED_FEATURES = [
  'dsh-acp',
  'dsh-slot-ui',
  'dsh-truncated-tool-calls',
  'dsh-model-slots',
  'dsh-governance-sandbox',
  'dsh-project-root',
] as const

/** Diagnostics logger that keeps stdout pure for the contract lines. */
const stderrLogger: CompatLogger = {
  warn: (message: string, ...args: unknown[]) => {
    console.error(message, ...args)
  },
}

// Host/client type-program boundary (tsconfig.host.json / tsconfig.client.json:
// "one program cannot see both"): this script is host-typed, so the sixth,
// CLIENT-face guard (packages/client/ui-settings-models) must not be a static
// import here (TS6307). A computed-specifier dynamic import keeps the client
// file out of the host program while the RUNTIME module graph stays
// single-channel: tsx resolves the very same file, and that file's own
// bare-specifier dsh-compat import goes through tsconfig paths — one module
// instance, one roster Map (the §15 invariant this tool exists to protect).
// Typed-shape dynamic-import precedent: model-slots src/compat.ts (SYNC-P2
// marker). A shape drift fails closed instead of booking nothing silently.
const slotUiGuardPath = '../packages/client/ui-settings-models/src/compat.ts'
const slotUiModule = await import(slotUiGuardPath) as { guardSlotUI?: (logger?: CompatLogger) => Promise<boolean> }
const guardSlotUI = slotUiModule.guardSlotUI
if (typeof guardSlotUI !== 'function') {
  throw new Error(`compat roster audit fail-closed: ${slotUiGuardPath} does not export guardSlotUI (client-face guard shape drifted; update this tool before the roster can book all six features)`)
}

console.error(`[audit] running ${String(EXPECTED_FEATURES.length)} zDSH guards (single module graph: bare-specifier dsh-compat + tsconfig paths)…`)
await guardACP(stderrLogger)
await guardSlotUI(stderrLogger)
await guardTruncatedToolCalls(stderrLogger)
await guardModelSlots(stderrLogger)
await guardGovernance(stderrLogger)
await guardProjectRoot(stderrLogger)

const roster = getCompatRoster()
const booked = [...roster.keys()].join(', ')

// Fail-closed self-check (rulings §15.2): the empty/partial bookkeeping that
// the TMP dual-instance defect produced must throw, never pass silently.
if (roster.size !== EXPECTED_FEATURES.length) {
  throw new Error(
    `compat roster audit fail-closed: expected exactly ${String(EXPECTED_FEATURES.length)} roster entries, got ${String(roster.size)} ([${booked}]) — usual cause: two dsh-compat module instances (import-channel split) or an unregistered/extra guard; always run via \`pnpm exec tsx scripts/audit-compat-roster.ts\` from the repo root`,
  )
}
for (const feature of EXPECTED_FEATURES) {
  if (!roster.has(feature)) {
    throw new Error(`compat roster audit fail-closed: expected feature '${feature}' is missing from the roster (booked: [${booked}])`)
  }
}

const dump: Record<string, { enabled: boolean; reason: string; checkedAt: string }> = {}
for (const [feature, entry] of roster) {
  dump[feature] = { enabled: entry.enabled, reason: entry.reason, checkedAt: entry.checkedAt }
}
const disabled = [...roster.entries()].filter(([, entry]) => !entry.enabled).map(([feature]) => feature)

console.log(`COMPAT_ROSTER_JSON: ${JSON.stringify(dump)}`)
console.log(`DISABLED_LIST: ${JSON.stringify(disabled)}`)
console.error(`[audit] done: ${String(roster.size)} features booked, ${String(disabled.length)} disabled.`)
