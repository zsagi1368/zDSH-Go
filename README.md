# zDSH-Go

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%E2%89%A524-blue.svg)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-11-blue.svg)](package.json) [![Upstream](https://img.shields.io/badge/DeepSeek%20Harness-0.1.3--alpha.1-purple.svg)](https://github.com/deepseek-ai/deepseek-harness) [![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#quick-start)

**zDSH-Go is the out-of-the-box distribution of [zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH)** — the enhanced fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), the open-source agent harness by [DeepSeek AI](https://deepseek.com) — with every self-developed plugin factory-bundled. Clone it, run the installer, and the full plugin suite is live on first boot.

## Why zDSH-Go

zDSH ships in two forms built from the same source tree. The main tree (`zdsh-latest` branch of [zsagi1368/deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH)) keeps the pure form: a lean harness where self-developed plugins are added explicitly when needed. zDSH-Go is the integration form — its **only** difference from the main tree is that all self-developed feature surfaces ship factory-bundled, so a fresh install runs the complete suite immediately, with zero manual `dsh plugin add` and zero profile editing.

| | Main tree (`zdsh-latest`) | zDSH-Go (this repository) |
|---|---|---|
| Source | zDSH fork of DeepSeek Harness | the same source tree |
| Self-developed plugins | added explicitly when needed | all factory-bundled |
| First boot | core harness + Web UI | full plugin suite already live |
| Fallback governance home | `~/.dsh-zdsh` | `~/.dsh-zdsh-go` (no collision with the main tree) |

> The upstream harness is in _developer preview_ and iterating rapidly — there will be compatibility-breaking changes. Review the [safety notice](SAFETY.md) before running the project.

## Bundled plugins and features

| Component | What it adds | Shipped as | Source |
|---|---|---|---|
| **Workbench** | IDE-grade dock workspace for the Web UI: files, editor, terminal, git, tasks, and browse panels behind one registry service | In-tree client package, factory-mounted | [zdsh-workbench](https://github.com/zsagi1368/zdsh-workbench) |
| **FileHub** | Unified file center: upload anywhere, reference anything with `@`, let the model read documents, and caption images | Factory-bundled plugin | [zdsh-filehub](https://github.com/zsagi1368/zdsh-filehub) |
| **Plugin Center** | Built-in plugin hub: discover, evaluate, install, update, and audit plugins from one settings page | Factory-bundled plugin | [zdsh-plugin-center](https://github.com/zsagi1368/zdsh-plugin-center) |
| **Plugin Registry catalog** | First-party plugin directory shipped as Plugin Center's built-in seed, so discovery works offline; the remote catalog stays the online channel | Offline seed bundled with Plugin Center | In-tree seed data |
| **AutoPilot** | Automation engine: Continue (auto-resume after interruptions), Guard (sandbox-first permission policy), and Review (read-only second-model reviewer) | Factory-bundled plugin | [zdsh-autopilot](https://github.com/zsagi1368/zdsh-autopilot) |
| **WebStack** | Integrated web search and fetch kernel, hardened by default; registers alongside the built-in providers in coexist mode | Factory-bundled plugin (three source packages) | [dsh-webstack](https://github.com/zsagi1368/dsh-webstack) |
| **Omnivision** | Vision bridge: every image is converted to a faithful text description before it reaches the model, so prefix caches stay warm | Factory-bundled plugin | [dsh-omnivision](https://github.com/zsagi1368/dsh-omnivision) |
| **ContextManagement** | Context cache management across the agent loop, session handling, token metering, and compaction | Core source-level integration | In-tree (applied to the branch source) |
| **dsh-guard** | Installation guard: checks the web profile for known plugin-ecosystem breakage patterns and reports without blocking installation | Single-file guard run by the installer | In-tree (`packages/plugins/dsh-guard`) |

<details>
<summary><strong>Plugin details — what each bundled component actually does</strong></summary>

- **Workbench** — one registry service (`ctx.workbench`) hosts the file workspace, terminal, git center, task center, and browse panels that other plugins extend. Registration is gated by a compat guard: if the host does not match, the workbench skips registration instead of throwing, and the host boots without it.
- **FileHub** — four upload entries (button, full-page drag & drop, paste, whole folders with hierarchy preserved) feeding one queue; `@` file mentions existence-checked at send time and injected as structured references; `read_document` opens text, PDF, DOCX, and XLSX with pagination and per-format budgets; an image captioning waterfall that defaults to a local Ollama instance so zero bytes leave your machine unless you say so; and a file console aggregating every session's files.
- **Plugin Center** — bounded catalog browsing with trust, compatibility, and pinned-source badges; installs pinned to an exact GitHub commit or npm semver; every install/update/uninstall is a one-shot plan confirmed by a code, with profile files hashed and backed up and any failure rolled back byte-for-byte; an append-only, secret-redacted audit trail.
- **Plugin Registry catalog** — the first-party plugin directory (catalog + SHA-256 sidecar) bundled as Plugin Center's local seed, with a three-level fallback (live catalog → digest-checked cache → bundled snapshot) so discovery works with no network at all.
- **AutoPilot** — one kernel, four cross-module invariants: a pending approval defers auto-resume; an open review circuit suppresses it; a global pause stops all modules; each approval is dispositioned exactly once. Everything is reachable from one `/ap` command surface with `conservative` / `standard` / `fullspeed` presets.
- **WebStack** — a single neutral aggregator registered into the host `ctx.web` seam. Layer routing across `native` / `free` / `api` / `selfhosted` / `mcp`, a keyless free pool that works with zero configuration, RRF fusion with time decay, a two-tier cache, and a four-gate SSRF pipeline. Ships in coexist mode: switching layers is a runtime config change, never a re-patch.
- **Omnivision** — images never enter the model request; a pre-step bridge describes them in text through a provider chain (LM Studio → Ollama → free/keyed cloud providers), so the request shape stays byte-identical and prefix caches stay warm. Failures produce no marker in the model context and are surfaced to the UI out-of-band. With no API keys at all, the anonymous free endpoint still provides vision.
- **ContextManagement** — integrated at the core source level: twelve patches applied directly to the branch source cover the agent loop, session handling, tools, token metering, model slots, compaction, and subagents, so context-cache management behaves as part of the core rather than a bolt-on plugin.
- **dsh-guard** — during install, a read-only `check` runs against the web profile, looking for known plugin-ecosystem breakage patterns. It reports and never blocks; the check is pinned to this installation's data face and never inspects the main tree.

</details>

<a id="quick-start"></a>

## Quick Start

### Prerequisites

| | |
|---|---|
| Node.js | `^22.19.0 || >=24` (23.x is not supported) |
| pnpm | ≥ 11 — enable with `corepack enable pnpm` (or `npm install -g pnpm`) |
| Git | any recent version |

### Install

zDSH-Go is distributed as source. Clone the repository and run the installer for your platform — it keeps all data inside the repository directory:

```sh
git clone https://github.com/zsagi1368/zDSH-Go.git
cd zDSH-Go

# Windows (PowerShell 5.1+)
.\install.cmd
# macOS / Linux / WSL / Git Bash
./scripts/install.sh
```

The installer checks the prerequisites, runs `pnpm install --frozen-lockfile` and `pnpm run build`, performs a read-only (non-blocking) `dsh-guard` check of the web profile, and generates:

- `data/` — the self-contained data home (`DSH_HOME`). Official module data and zDSH-Go governance data (plugin registry, approval ledger, and installed plugins under `data/zdsh/`) are both kept here.
- `env.ps1` / `env.sh` — environment loaders that define `DSH_HOME`, `DSH_BRANCH_HOME`, `DSH_AGENTS_HOME`, and a `dsh` command pointing at the built CLI.

<a id="run"></a>

### Run

Load the environment, then start the Web UI:

```sh
# PowerShell
. .\env.ps1
# bash
source ./env.sh

dsh web
```

`dsh web` starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL, because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser.

<a id="run-from-source"></a>

Alternatively, run straight from a checkout without the installer:

```sh
pnpm install
pnpm run build
pnpm dsh web
```

## Configuration

The installation is **self-contained**: all data lives inside `<repo>/data`, and nothing outside the repository directory is written by default.

| Variable | Points at | Default |
|---|---|---|
| `DSH_HOME` | Data home: official module data | `<repo>/data` |
| `DSH_BRANCH_HOME` | zDSH-Go governance data: plugin registry, approval ledger, installed plugins | `<repo>/data/zdsh` |
| `DSH_AGENTS_HOME` | Official skills home | `<repo>/data/agents` |

**Custom data directory** — edit `DSH_HOME` (and `DSH_BRANCH_HOME` / `DSH_AGENTS_HOME` as needed) in the generated `env.ps1` / `env.sh` and re-load it. Re-running the installer regenerates both files from the repository location, so re-point them afterwards if you relocate.

The governance-data root resolves in order: explicit `DSH_BRANCH_HOME` → `<DSH_HOME>/zdsh` → the fallback home `~/.dsh-zdsh-go`. The fallback only applies when neither variable is set, so a self-contained install never touches it. It is deliberately distinct from the main tree's `~/.dsh-zdsh`, which is why both distributions can coexist on one machine.

## Update and uninstall

**Update:** pull the latest `zDSH-go` branch and re-run the platform installer — it re-installs dependencies with a frozen lockfile and rebuilds.

**Uninstall:** run the uninstaller for your platform from a repository checkout:

```sh
# Windows (PowerShell 5.1+)
.\uninstall.cmd
# macOS / Linux / WSL / Git Bash
./scripts/uninstall.sh
```

| Mode | What it does |
|---|---|
| default | Removes every gitignored artifact inside the checkout (`node_modules`, build output, `data/`, `env.ps1` / `env.sh`), restoring a pristine checkout state. User-local files it might remove (`.env`, `.claude/`, and similar) are backed up to a temp directory first, with a `RESTORE.txt` inside. It never touches anything outside the repository directory. |
| `--purge` (PowerShell: `-Purge`) | Additionally deletes the whole repository directory afterwards. |
| `--clean-legacy` (PowerShell: `-CleanLegacy`) | Additionally removes the zDSH-Go home (`~/.dsh-zdsh-go`) and the legacy plugin homes (`~/.zdsh-workbench`, `~/.zdsh-plugin-center`). The main-tree data directory `~/.dsh-zdsh` is **NOT** touched. |

`~/.dsh` belongs to the official release and may hold data shared with it — it is only removed after explicit interactive confirmation (or `--yes` / PowerShell `-Yes`). The script never deletes `~/.agents`; it only reports its presence. A residue scan of the user home directory is printed on every run.

## Security

- **dsh-guard check** — the installer runs a read-only, non-blocking integrity check of the web profile. It reports known breakage patterns and continues on failure (a fresh install has no profile yet, so a warning there is normal). The check is pinned to this installation's data face and never inspects `~/.dsh` or any other installation.
- **Data localization** — the self-contained layout keeps official module data, governance data, and installed plugins under `<repo>/data`. Nothing outside the repository directory is written unless `DSH_HOME` is unset, in which case the dedicated `~/.dsh-zdsh-go` fallback applies.
- **Bundled-plugin hardening** — the suite inherits each component's security model: WebStack's four-gate SSRF pipeline, FileHub's path sandbox and loopback-only local probes, Plugin Center's pinned installs with byte-exact rollback, AutoPilot's structural redaction on everything crossing a model boundary, and Omnivision's SSRF guards and three-layer credential redaction.
- Read the [safety notice](SAFETY.md) before running the project.

## FAQ

**How does zDSH-Go relate to the zDSH main tree?** Same source tree, different integration depth. The main tree (`zdsh-latest` branch of [zsagi1368/deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH)) is where development happens in pure form; zDSH-Go is the same code with every self-developed plugin factory-bundled. They install independently and can coexist: zDSH-Go's fallback home is `~/.dsh-zdsh-go`, the main tree's is `~/.dsh-zdsh`, and neither uninstaller touches the other's data.

**Can I install only some of the bundled plugins?** zDSH-Go does not ship a "pick your subset" installer — the bundle is factory-mounted by design. The bundled plugins are normal plugins and manageable from the Web UI. If you want a curated set, use the main tree instead and add exactly what you need through Plugin Center or `dsh plugin add`.

**How do I update?** `git pull` the `zDSH-go` branch, then re-run `.\install.cmd` (Windows) or `./scripts/install.sh` (macOS/Linux). The installer re-installs dependencies with a frozen lockfile and rebuilds. Your `data/` directory stays in place.

**Why is ContextManagement a source-level integration instead of a plugin?** Because it changes core behavior — the agent loop, session handling, token metering, compaction — it is applied as twelve core patches directly to the branch source rather than mounted as a plugin. A plugin variant of the same functionality exists as an alternative track; the two are never mounted together, so there is no double registration.

**Does it conflict with an existing official DeepSeek Harness installation?** No. Official-release data lives in `~/.dsh` and is never written to by zDSH-Go's self-contained layout; the uninstaller only touches it after explicit confirmation, and never deletes `~/.agents`.

## Contributing

Contributions follow the main tree's conventions — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [development guide](docs/development.md). For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgements

- **Upstream:** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by [DeepSeek AI](https://deepseek.com) — official documentation at [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/).
- **Self-developed components bundled in this distribution:** [zdsh-workbench](https://github.com/zsagi1368/zdsh-workbench), [zdsh-plugin-center](https://github.com/zsagi1368/zdsh-plugin-center), [zdsh-filehub](https://github.com/zsagi1368/zdsh-filehub), [zdsh-autopilot](https://github.com/zsagi1368/zdsh-autopilot), [dsh-webstack](https://github.com/zsagi1368/dsh-webstack), [dsh-omnivision](https://github.com/zsagi1368/dsh-omnivision), plus ContextManagement and dsh-guard, integrated in-tree.
