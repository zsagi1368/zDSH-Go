# DESIGN — zdsh-autopilot

> Architecture record for the unified automation engine. Full planning suite lives outside this repo (PluginR&D `plan/00–07`); this file captures what an implementer or reviewer needs.

## 1. What it is

One plugin, three automation capabilities behind a shared kernel and one console:

| Module | Seam | Summary |
|---|---|---|
| **continue** | session/event firehose | Detects non-human interruptions (`error`, `max-tokens`; never `aborted`/`blocked`), auto-sends the resume prompt after a grace window with adaptive backoff, idempotency guardrails keyed on the previous tool's terminal state, and a three-signal loop guard ("change is progress"). |
| **guard** | tools fuse / pre-execute waterfall / approval seam | Four-level monotonic stack: synchronous hard-deny fuse → deterministic rules (from-scratch bash/pwsh lexer; deletion tiers anchored on file-identity session artifacts) → LLM classifier over redacted inputs with a strict output protocol and deny→ask failure ladder → official human approval bridged by five-tuple one-shot escalation grants (single popup). |
| **review** | approval/request answerer chain | Read-only second-model reviewer subagent decides allow/deny under a full claim conjunction; fail-closed via total-function failure mapping; budgets per open turn (decisions vs failures); derived-default circuit breaker wired into cross-module suppression; denial reasons injected back into error results with audit markers. |

Kernel services (host-agnostic pure TS): coordination fan-out with four cross-module invariants, attempt-before-side-effect ledger accounting with dual turn budgets, `ap/*` audit vocabulary with folds + markers + the "model-visible ⟺ recorded" invariant checker, two-profile redaction pipeline, three-level capability probing with an ASSUMPTIONS registry, single-source-of-truth defaults.

## 2. Module boundaries (CI-enforced)

`scripts/check-boundaries.mjs` fails lint when:
- any capability module imports another capability module (only `../kernel/*` + self allowed);
- kernel or shared-client imports anything upward;
- source references third-party DSH plugin packages (originality guard).

The split-out path is physical: each module directory has no inward dependencies beyond the facade, so a future standalone package = kernel copy + one module.

## 3. Cross-module invariants (the reason this is one engine)

Enforced in `kernel/coordinator.ts`:
1. A session with a pending approval DEFERS auto-resume (re-armed, not dropped).
2. An open review circuit SUPPRESSES auto-resume (`skipped: circuit-open`) — no rejection storms.
3. Global pause stops all modules.
4. One approval callId is dispositioned exactly once (first claim wins).

## 4. Failure philosophy

Closed vocabulary `timeout | cancelled | unavailable | schema | budget | circuit-open`. Every async edge converges on it; every module declares a total mapping to a safe outcome (continue: give up this attempt; guard: deny then human ladder; review: fallbackPolicy, default rejected). Cancellation never burns failure budgets. Exhaustiveness is compile-checked.

## 5. Security posture

- Authorization sources: ONLY direct-human messages and pre-execution facts. Everything else is data.
- All model-boundary payloads pass structural+textual redaction (strict profile forced for cross-provider targets).
- Action endpoint: token-or-same-origin authorization, 4 KiB cap, host is the only actor.
- Path judgment hardening: NT namespace folds, reserved device names, drive-relative ambiguity, trailing-dot strips, case folding, cross-drive containment guard (`isAbsolute` — the win32 relative() trap).
- One-shot grants bind (session, tool, callId, level, justification) and burn on consumption or settlement.
- Session-log events use ignorable envelopes so hosts that drop options degrade cleanly to the in-memory mirror.

## 6. Originality

zdsh-autopilot is an original, from-scratch implementation. All architecture, module structure, naming (`ap/*` vocabulary, `/ap` surface), and code were created for this project. The repository carries mechanical guards for this policy: `scripts/check-boundaries.mjs` rejects any dependency on or reference to third-party DSH plugin packages in shipped source, and CI enforces it on every push.

## 7. Host compatibility notes

- Requires DSH ≥ 0.1.0-rc.2 (peer `>=0.1.0-rc.2`, all optional; manifest carries no upper bound). Developed and pinned against `0.1.2-rc.1` (closest reproducible registry snapshot to the zDSH 0.1.3-alpha.1 baseline; compatibility verified against 0.1.3-alpha.1).
- Every host-seam assumption is registered in `src/index.ts` probe registrations with feature detection; missing services disable wiring rather than failing startup.
