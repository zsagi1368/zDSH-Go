<h1 align="center">zDSH Plugin Center</h1>

<p align="center">
  <a href="https://github.com/zsagi1368/zdsh-plugin-center/actions/workflows/ci.yml"><img src="https://github.com/zsagi1368/zdsh-plugin-center/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/zsagi1368/zdsh-plugin-center/releases/latest"><img src="https://img.shields.io/github/v/release/zsagi1368/zdsh-plugin-center?style=flat-square" alt="Release"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.13-339933?style=flat-square" alt="Node ≥22.13">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square" alt="License: MIT"></a>
</p>

<p align="center">
  A built-in plugin hub for DeepSeek Harness (DSH): discover, evaluate, install,
  update and audit plugins from one settings page — safely, on Windows first.<br>
  中文文档见 <a href="README.zh.md">README.zh.md</a>
</p>

---

## Two ways to run it

| | Setup |
|---|---|
| **zDSH branch** | Already built in. If you run the [zDSH branch](https://github.com/zsagi1368/deepseek-harness-zDSH) of DeepSeek Harness, Plugin Center ships as a core extension — open **Settings → 插件中心 / Plugin Center** and go. |
| **Stock DeepSeek Harness** | Install it like any plugin, pinned to a release commit (below). |

## Why

Installing a DSH plugin today means pasting a CLI command and trusting whatever
lands in your profile. Plugin Center turns that into a reviewed, reversible
workflow driven from the web UI — while staying a normal plugin itself:
no host patches beyond the standard bundle declaration, no privileged helpers.

## Features

**Marketplace**
- Bounded catalog browsing (24 entries per page) with search, category filter
  and a recommended-only toggle
- Three badges per entry: trust evidence · compatibility projection · pinned
  source (GitHub commit or npm version)
- Graceful offline behavior: live catalog → digest-checked cache → bundled
  snapshot, with a visible banner whenever data may be stale

**Trust model**
- GitHub installs are pinned to an exact 40-hex commit; npm installs to an
  exact semver — floating branches are rejected before a plan can exist
- Four-level evidence scale (`discovered` → `recommended`) and a three-level
  compatibility projection shown on every card
- Remote catalogs must ship a matching SHA-256 sidecar; unsigned snapshots are
  refused

**Safe lifecycle transactions**
- Every install / update / uninstall is a one-shot plan confirmed by a random
  code returned exactly once at staging
- Before anything runs: profile files are hashed and backed up. After: state
  is re-compared, a health probe runs, and any failure rolls the profile back
  byte-for-byte with verification
- Lifecycle scripts declared by a target are denied unless explicitly
  allow-listed (`script_blocked`)
- An append-only audit trail records every step — filtered through secret
  redaction before it touches disk

**Restart orchestration**
- A detached Node watchdog probes a hardcoded loopback address and relaunches
  the host after crashes, bounded to 3 restarts per 5 minutes with a give-up
  circuit — no launchd, schtasks or systemd required

**Operations & UX**
- Watchdog controls, backup restore and uninstall live next to the market
- Fully bilingual interface (中文默认，可切换 English) built on theme alias
  variables, with mobile-friendly layout

## Requirements

| | |
|---|---|
| DeepSeek Harness | a profile with the web client enabled |
| Node.js | ≥ 22.13 |
| Platforms | Windows (first-class), macOS, Linux |

## Installation (standalone)

Pin the exact release commit — see the
[releases page](https://github.com/zsagi1368/zdsh-plugin-center/releases)
for the current one:

```bash
dsh plugin --profile web add 'git+https://github.com/zsagi1368/zdsh-plugin-center.git#<release-commit>'
```

Then open **Settings → 插件中心 / Plugin Center** in your web profile.

## How an install flows

```
browse / search            → bounded pages, badges, detail metadata
stage a plan               → server validates pins, scripts policy and trust level
type the confirmation code → consumes the one-shot plan
apply                      → hash → backup → pinned install → verify → health
done                       → “restart required” banner; watchdog available
any failure                → byte-verified rollback + audit record
```

## Configuration

Everything is optional; defaults serve the bundled catalog read-write against
the `web` profile. Common switches:

| Key | Effect |
|---|---|
| `remoteCatalogUrl` | point at a signed remote catalog (e.g. [zdsh-plugin-registry](https://github.com/zsagi1368/zdsh-plugin-registry)) |
| `mutationsEnabled: false` | read-only kiosk mode |
| `webPort` | loopback port of the DSH web host used by the watchdog |

Full reference with examples and the `~/.zdsh-plugin-center` data layout:
[docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## Security

Threat model, guarantees (pinned targets, one-shot plans, byte-exact rollback,
script gating, SSRF guard, same-origin + intent gates, secret-free audit,
bounded restarts) and accepted residual risks are documented in
[SECURITY.md](SECURITY.md).

## Project documentation

| Document | Contents |
|---|---|
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | every config key, defaults, examples, data layout |
| [SECURITY.md](SECURITY.md) | threat model and guarantees |
| [docs/INTEGRATION-PLAYBOOK.md](docs/INTEGRATION-PLAYBOOK.md) | packaging notes for host distributions |
| [CHANGELOG.md](CHANGELOG.md) | release history (bilingual) |

## Development

```bash
pnpm install
pnpm lint        # tsc --noEmit, strict
pnpm build       # tsdown: host ESM + client loader bundle + watchdog entry
pnpm test        # vitest: unit + contract + closed-loop integration suites
```

The integration suite boots a real HTTP server and drives a real child-process
CLI stand-in against real temp profile files. CI runs the full gate on both
ubuntu-latest and windows-latest.

Agent-facing conventions live in [AGENTS.md](AGENTS.md).

## Known limitations (v0.x)

- The `restart/request` route reports `not_implemented`; manage the watchdog
  through its toggle routes and restart the host manually for now.
- Script gating falls back to the catalog's declared policy when a target's
  live manifest cannot be fetched.
- Outbound fetches judge literal hosts only; resolved-address pinning is
  future work.

## License

[MIT](./LICENSE)
