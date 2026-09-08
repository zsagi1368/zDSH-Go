# zDSH

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

zDSH is an enhanced fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the open-source agent harness developed by [DeepSeek AI](https://deepseek.com). It tracks the official upstream releases while adding version-adaptive enhancements that automatically disable themselves when they would conflict with the core environment.

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

This repository (`zsagi1368/deepseek-harness-zDSH`) is the zDSH fork. The active development branch is `zdsh-latest`, kept in sync with the latest official release.

## Developer preview

zDSH tracks a harness that is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Installation

zDSH is distributed as source. Clone this repository and run the installer for your platform — it keeps all data inside the repository directory:

```sh
git clone https://github.com/zsagi1368/deepseek-harness-zDSH.git
cd deepseek-harness-zDSH
git checkout zdsh-latest

# Windows (PowerShell 5.1+)
.\install.cmd
# macOS / Linux / WSL / Git Bash
./scripts/install.sh
```

The installer checks the prerequisites (`Node.js ^22.19.0 || >=24` and `pnpm`), runs `pnpm install --frozen-lockfile` and `pnpm run build`, and generates:

- `data/` — the data home (`DSH_HOME`). Official module data and zDSH governance data (plugin registry, approval ledger, and installed plugins under `data/zdsh/`) are both kept here.
- `env.ps1` / `env.sh` — environment loaders that define `DSH_HOME`, `DSH_AGENTS_HOME`, and a `dsh` command pointing at the built CLI.

## Run

Load the environment, then start the Web UI:

```sh
# PowerShell
. .\env.ps1
# bash
source ./env.sh

dsh web
```

`dsh web` starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser.

Alternatively, run straight from a checkout without the installer:

<a id="run-from-source"></a>

```sh
pnpm install
pnpm run build
pnpm dsh web
```

## Uninstall

Run the uninstaller for your platform from a repository checkout:

```sh
# Windows (PowerShell 5.1+)
.\uninstall.cmd
# macOS / Linux / WSL / Git Bash
./scripts/uninstall.sh
```

By default it removes every gitignored artifact inside the checkout (`node_modules`, build output, `data/`, `env.ps1` / `env.sh`), restoring a pristine checkout state — it never touches anything outside the repository directory. Additional options: `--purge` (PowerShell: `-Purge`) also deletes the whole repository directory afterwards; `--clean-legacy` (PowerShell: `-CleanLegacy`) also removes the zDSH-go home directory (`~/.dsh-zdsh-go`) and the legacy plugin homes (`~/.zdsh-workbench`, `~/.zdsh-plugin-center`); the main-tree zDSH data directory `~/.dsh-zdsh` is NOT touched. `~/.dsh` belongs to the official release and is only touched after explicit confirmation; the script never deletes `~/.agents` and only reports its presence.

## zDSH enhancements

zDSH adds version-adaptive features on top of the official harness; each one probes the installed core and disables itself cleanly when the environment does not match, so an upstream drift never breaks the base product. Highlights include the model-slot routing system, project-level plugin roots with host-clamped sandboxes, plugin governance, and a self-contained install layout. See the [zDSH subsystems guide](docs/subsystems/zdsh.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For agents, follow [AGENTS.md](AGENTS.md). Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

## License

[MIT](LICENSE). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## About the upstream: DeepSeek Harness (official)

zDSH is a fork; the original project is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by [DeepSeek AI](https://deepseek.com). For the official release:

- **Official repository:** [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- **Official documentation:** [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/)
- **Run from npm (official package):**

```sh
npx @deepseek-ai/dsh web
```

- **Official community and support:** submit feedback through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions), add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability, or join the [DeepSeek Harness Discord community](https://discord.gg/Ycq5dCaS4).
