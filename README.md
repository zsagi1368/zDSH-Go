# zDSH-Go

English | [中文](README.zh.md)

[![CI](https://github.com/zsagi1368/zDSH-Go/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/zDSH-Go/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%E2%89%A524-blue.svg)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-11-blue.svg)](package.json) [![Upstream](https://img.shields.io/badge/DeepSeek%20Harness-0.1.5--rc.2-purple.svg)](https://github.com/deepseek-ai/deepseek-harness) [![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#quick-start)

**zDSH-Go is [zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) with a major context-handling adjustment.** zDSH is the enhanced fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the open-source agent harness by [DeepSeek AI](https://deepseek.com). In zDSH-Go, context-cache management is integrated at the core source level, so it cannot ship as a plugin; everything else about zDSH stays as it is. Self-developed plugins are not factory-bundled here — you get them through the zDSH main line and its plugin governance channel.

## The zDSH lineage

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (official) → **zDSH** ([zsagi1368/deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH): official latest + the self-developed plugin suite = the out-of-the-box distribution) → **zDSH-Go** (this repository: zDSH + the core-level context adjustment = the adjustment distribution).

- zDSH-Go's upstream is always zDSH; it is never synced from the official repository directly.
- The self-developed plugins live in the zDSH main line. zDSH-Go ships only the official in-tree packages (`plugin-governance`, `plugin-project-root`) plus the in-tree Workbench client, and installs further plugins through the governance channel (`pluginGovernance.install` resolves pinned npm sources).

| | Official DeepSeek Harness | zDSH (main line) | zDSH-Go (this repository) |
|---|---|---|---|
| Role | upstream harness by DeepSeek AI | official latest + self-developed plugin suite | zDSH + core-level context adjustment |
| Context handling | upstream behavior | upstream behavior | core source-level integration (not a plugin) |
| Self-developed plugins | — | the full suite, installable through governance | none bundled; install through the zDSH governance channel |
| Fallback governance home | `~/.dsh` | `~/.dsh-zdsh` | `~/.dsh-zdsh-go` (no collision with either) |

> The upstream harness is in _developer preview_ and iterating rapidly — there will be compatibility-breaking changes. Review the [safety notice](SAFETY.md) before running the project.

## What the context adjustment changes

The adjustment is applied to the core source — the agent loop, session handling and projection, tools, token metering, model slots, compaction, and subagents — so context-cache management behaves as part of the core rather than a bolt-on plugin. Concretely:

- **Core-level context cache management.** Every request path the core owns participates: the agent loop, session processing, tools, token metering, model slots, and compaction all share one cache-aware context lifecycle instead of trusting an add-on to retrofit it.
- **Subagent prompts carry a runtime-context snapshot.** The initial prompt of every subagent is prefixed with a runtime-context snapshot block, so spawned workers start from the same context facts as their parent.
- **Fork and team members start unseeded.** Team and fork member sessions no longer pre-seed a session header — the seed stays where it belongs, with the parent.
- **Context pruning is observable.** File read and search tool results expose `l3.pruning { bytes, prunable }` metadata: the pruned byte count and the prunable remainder are visible right in the tool output.
- **A standing budget gate.** `scripts/verify-budget-table.ts` is registered as a verification gate — developers and CI keep the token-budget tables honest on every change.

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

The installer checks the prerequisites, runs `pnpm install --frozen-lockfile` and `pnpm run build`, and generates:

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

**Update:** pull the latest changes of this repository's default branch and re-run the platform installer — it re-installs dependencies with a frozen lockfile and rebuilds.

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

- **Data localization** — the self-contained layout keeps official module data, governance data, and installed plugins under `<repo>/data`. Nothing outside the repository directory is written unless `DSH_HOME` is unset, in which case the dedicated `~/.dsh-zdsh-go` fallback applies.
- **Official isolation** — official-release data lives in `~/.dsh` and is never written to by zDSH-Go's self-contained layout; the uninstaller only touches it after explicit confirmation, and never deletes `~/.agents`.
- Read the [safety notice](SAFETY.md) before running the project.

## FAQ

**How does zDSH-Go relate to the zDSH main line?** zDSH-Go is zDSH plus one thing: the context adjustment, applied at the core source level. The main line (`zdsh-latest` branch of [zsagi1368/deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH)) hosts the self-developed plugin suite and upstream tracking; zDSH-Go follows the main line and re-applies the context adjustment on top. They install independently and can coexist: zDSH-Go's fallback home is `~/.dsh-zdsh-go`, the main line's is `~/.dsh-zdsh`, and neither uninstaller touches the other's data.

**Where do the self-developed plugins come from?** From the zDSH main line, through its plugin governance channel — `pluginGovernance.install` resolves pinned npm sources with a confirmation-gated admission flow. zDSH-Go itself ships no bundled plugins; the only in-tree packages are the official `plugin-governance` and `plugin-project-root`.

**How do I update?** `git pull` this repository's default branch, then re-run `.\install.cmd` (Windows) or `./scripts/install.sh` (macOS/Linux). The installer re-installs dependencies with a frozen lockfile and rebuilds. Your `data/` directory stays in place.

**Why is the context adjustment a source-level integration instead of a plugin?** Because it changes core behavior — the agent loop, session handling, token metering, compaction — it is applied directly to the core source rather than mounted as a plugin. A plugin can only sit beside the core; cache management has to be inside every path the core owns.

**Does it conflict with an existing official DeepSeek Harness installation?** No. Official-release data lives in `~/.dsh` and is never written to by zDSH-Go's self-contained layout; the uninstaller only touches it after explicit confirmation, and never deletes `~/.agents`.

## Contributing

Contributions follow the main line's conventions — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [development guide](docs/development.md). For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgements

- **Upstream:** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by [DeepSeek AI](https://deepseek.com) — official documentation at [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/).
- **Lineage:** [zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) — the main line that tracks the official releases and hosts the self-developed plugin suite (Workbench, Plugin Center, FileHub, AutoPilot, WebStack, Omnivision). zDSH-Go derives from it and integrates the context adjustment in-tree.

---

## About the upstream: DeepSeek Harness (official)

zDSH-Go is a downstream distribution; the original project is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by [DeepSeek AI](https://deepseek.com). For the official release:

- **Official repository:** [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- **Official documentation:** [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/)
- **Run from npm (official package):**

```sh
npx @deepseek-ai/dsh web
```

- **Official community and support:** submit feedback through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions), add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability, or join the [DeepSeek Harness Discord community](https://discord.gg/Ycq5dCaS4).
