# Changelog

All notable changes to this project are documented here. Format follows Keep a Changelog; versioning is SemVer.

## [0.1.0] - 2026-08-24

First public release of the unified automation engine. Three capabilities behind one kernel and one console:

### Added — kernel
- Host-agnostic kernel layer: coordination fan-out with four cross-module invariants (pending-approval defers auto-resume; review circuit suppresses it; global pause stops everything; one approval callId dispositioned exactly once).
- Attempt-before-side-effect ledger accounting: per-session cooldowns with a derived backoff curve, dual per-turn budgets (decisions vs failures), cancellation never burns failure budget.
- Unified `ap/*` audit vocabulary over ignorable session-log envelopes, pure folds ("replay is state"), `[autopilot:<event>/<id>]` markers, and the model-visible ⟺ recorded invariant checker.
- Two-profile redaction pipeline (standard / strict) covering secret-named keys, bulk content keys, token shapes, Bearer headers, AWS key ids, PEM blocks, connection strings.
- Three-level capability probing framework with an ASSUMPTIONS registry.
- Single-source-of-truth defaults tree with clamps and the `=maxReviews` sentinel.

### Added — continue (interruption self-heal)
- End-reason whitelist detection plus an error corpus separating permanent failures from transient ones; unknown errors default to resume-worthy.
- Two-gate grace scheduling with self-heal veto, cooldown inclusive of failed attempts, consecutive limit, and deferred-not-dropped coordination re-arm.
- Idempotency guardrails keyed on previous tool state (pending → verify-first, done → do-not-redo, failed → no guardrail).
- Loop guard with three complementary idle signals, change-is-progress reset, one interrupt per turn.

### Added — guard (sandbox-first permission)
- Monolithic hard-deny fuse: privilege escalation, execution-policy changes, credential-tree transfer/deletion, critical paths, reserved device names, drive-relative ambiguity.
- From-scratch bash/PowerShell lexer with opaque-fallback semantics; deletion five tiers anchored on file-identity session artifacts (`dev`/`ino`/`birthtime` quadruple, snapshot diffing with birth-time gates, vacuous-tree protection).
- LLM classifier over redacted inputs with pre-execution facts, strict two-key output protocol, deny×N→human failure ladder.
- One-shot escalation grants bound to five elements, consumed once, settled unconditionally; single-popup bridging through the official approval seam.

### Added — review (second-model approval review)
- Claim conjunction (recursion identity set ∧ enabled ∧ policy ∧ budgets ∧ circuit ∧ audit correlation); correlation break maps to unavailable, never authorization.
- Evidence-only reviewer prompt hygiene with human-override-as-context consumed by construction.
- Derived-default circuit breaker wired into cross-module suppression; reject-action answers with marker-carrying feedback.
- Denial reasons injected into error results via TTL feedback loop so agents learn why they were refused.

### Added — console & operations
- `/ap` command surface (status, on/off, pause/resume, approve, presets, stats reset).
- Status/action HTTP bridge with token-or-same-origin authorization and payload caps.
- Browser fiber registering locale + settings card + session panel through official slots only — zero DOM scraping.
- zh/en locale dictionaries with CI-enforced key parity.
- Offline behavior-contract harness: YAML cases drive real module factories through scripted adapters (no API key), exit code gates CI. 10 cases shipped.
- 134 unit/behavior tests; architecture boundary + dependency-originality guards in lint; dual-face build (host ESM `lib/`, browser classic-script `dist/client.cjs`).
