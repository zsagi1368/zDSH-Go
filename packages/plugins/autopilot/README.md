# zdsh-autopilot

[![ci](https://github.com/zsagi1368/zdsh-autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/zdsh-autopilot/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/tag/zsagi1368/zdsh-autopilot?label=release&sort=semver)](https://github.com/zsagi1368/zdsh-autopilot/releases)
[![license](https://img.shields.io/github/license/zsagi1368/zdsh-autopilot)](LICENSE)

**zDSH AutoPilot（自动领航）** — the unified automation engine for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Three cooperating capabilities behind one kernel and one console:

| | Module | What it does |
|---|---|---|
| ⏵ | **Continue** | Detects non-human interruptions (network errors, truncated turns) and resumes the session automatically — adaptive backoff, idempotency guardrails keyed on where the previous turn died, and a loop guard that tells spinning from progress. |
| 🛡 | **Guard** | Sandbox-first permission policy: routine work runs without prompts inside the OS sandbox; semantic risks go through a redacted LLM classifier with a strict output protocol; out-of-boundary work gets a five-element one-shot escalation grant answered at the official approval seam — one popup, ever. |
| 🔎 | **Review** | A read-only second-model reviewer subagent answers approval requests under a full claim conjunction, fail-closed by default, with dual budgets, a derived-default circuit breaker, and denial reasons fed back into error results. |

English | [简体中文](README.zh.md)

---

## Why one engine

Automation modules that cannot see each other produce the worst failures: auto-resume firing into a fresh rejection storm, three settings cards with three audit formats, a pause that pauses only one thing. AutoPilot is built as **one kernel with four cross-module invariants**:

1. A session with a **pending approval defers auto-resume** — deferred and re-armed, never dropped.
2. An open review circuit **suppresses auto-resume** (`skipped: circuit-open`) — no rejection storms while unattended.
3. A single **global pause stops all modules**.
4. One approval callId is **dispositioned exactly once** — first claim wins, double popups are impossible.

Everything shares one accounting model (attempts are booked before side effects; cancellations never burn failure budgets), one audit vocabulary (`ap/*` session-log events with replayable folds and mechanical marker checking), and one failure language (`timeout | cancelled | unavailable | schema | budget | circuit-open`, mapped to safe outcomes exhaustively).

## Requirements

| | |
|---|---|
| DeepSeek Harness | `>= 0.1.0-rc.2`, `< 0.2.0` |
| Node (host) | `>= 22` |
| Platforms | Windows / macOS / Linux (path judgment hardened for Windows first) |

All runtime host capabilities are feature-detected with graceful degradation; a missing service disables its wiring instead of failing startup.

## Install

**zDSH branch — nothing to do.** AutoPilot ships as a bundled extension of the [deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) branch: install the branch and it is active out of the box, manageable from Settings → Plugins.

**Upstream DSH or any other profile:**

```bash
# from GitHub
dsh plugin --profile web add github:zsagi1368/zdsh-autopilot

# or from a local checkout
dsh plugin --profile web add link:/path/to/zdsh-autopilot
```

Then open **Settings → Plugins → AutoPilot**, pick a preset, done.

## Usage

Everything is reachable from one command surface:

```text
/ap                          status of all modules + today counters
/ap on|off [continue|guard|review]
/ap pause [duration]         /ap resume
/ap approve                  authorize the latest denial (one-shot context)
/ap preset conservative|standard|fullspeed
/ap reset-stats              /ap help
```

Presets are named configuration sets applied over user settings:

| Preset | Continue | Guard | Review |
|---|---|---|---|
| **conservative** | off | strict ladder, human-leaning fallback | delegate fallback |
| **standard** (default) | on | balanced | rejected fallback |
| **fullspeed** | fast backoff | relaxed ladder | wider budgets |

Configuration lives in the `autopilot:` namespace of your DSH settings file (hot reload); deployment defaults ship via the bundle patch. Every knob is documented inline and derived from a single source of truth in code.

## Architecture

```text
src/
├── kernel/      shared facade: coordinator · ledger · audit(ap/*) · redact · probes · defaults
├── continue/    detector · scheduler · loopguard · resume texts
├── guard/       path hardening · shell lexer (bash/pwsh) · artifacts · classifier · grants
├── review/      answerer · reviewer prompt/verdict · circuit · feedback
├── console/     command parser · status/action bridge (token-or-same-origin auth)
└── client/      browser fiber — official slots only, zero DOM scraping
eval/            offline behavior contracts: YAML cases drive real module factories
corpus/          extensible error-classification corpus
```

Module boundaries are enforced in CI (`scripts/check-boundaries.mjs`): capability modules may import only the kernel facade and themselves. Each module directory is therefore extractable into a standalone plugin without refactoring.

The same source tree powers both distributions — the zDSH monorepo vendored build and this standalone package — keeping behavior identical across them.

## Development

```bash
pnpm install
pnpm verify     # lint(boundaries) + typecheck(3 configs) + vitest + build + eval
pnpm eval       # offline behavior-contract suite only (no API key needed)
```

Quality gates shipped in-repo:

- **134 unit/behavior tests** across kernel and all modules, plus platform-aware path/shell fixtures;
- **10 YAML behavior contracts** executed against the real module factories headlessly, gated by process exit code;
- **boundary + dependency guards** in lint;
- dual-face build verification (`lib/` ESM for the host, classic-script bundle for the web client);
- every assumption about a host seam registered in `kernel/probes` with a probe and degradation path.

## Security notes

- Authorization sources are limited to direct human messages and pre-execution facts; repository content, tool output, and assistant text are treated as data, never instructions.
- Everything crossing a model boundary passes structural redaction (secret-named keys, bulk content, token shapes, PEM blocks, connection strings).
- Action endpoints require token or same-origin authorization and cap payload size.
- Escalations bind session/tool/call/level/justification, consumable exactly once.

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture record and [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE) © 2026 zsagi1368
