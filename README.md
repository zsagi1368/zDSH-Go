# zDSH

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

zDSH is an enhanced fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the open-source agent harness developed by [DeepSeek AI](https://deepseek.com). It tracks the official upstream releases while adding version-adaptive enhancements that automatically disable themselves when they would conflict with the core environment.

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

This repository (`zsagi1368/deepseek-harness-zDSH`) is the zDSH fork. The active development branch is `zdsh-latest`, kept in sync with the latest official release.

## Developer preview

zDSH tracks a harness that is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## The zDSH-go branch

The active development branch `zdsh-latest` is the main tree: it keeps the pure zDSH form, where self-developed plugins are added explicitly when needed. The `zDSH-go` branch is the out-of-the-box integration branch of the same source tree — its only difference from the main tree is that every self-developed zDSH plugin ships factory-bundled, so a fresh install runs the full plugin suite immediately. Installing it works the same way as below: clone this repository, check out `zDSH-go`, then run the installer for your platform.

| Component | What it adds | Mount form |
|---|---|---|
| Workbench | IDE-grade dock workspace for the Web UI: files, editor, terminal, git, tasks, and browse panels behind one registry service | In-tree client package, factory-mounted |
| FileHub | Unified file center: upload anywhere, reference anything with `@`, let the model read documents, and caption images | Factory-bundled plugin |
| Plugin Center | Built-in plugin hub: discover, evaluate, install, update, and audit plugins from one settings page | Factory-bundled plugin |
| AutoPilot | Automation engine: Continue (auto-resume after interruptions), Guard (sandbox-first permission policy), and Review (read-only second-model reviewer) | Factory-bundled plugin |
| WebStack | Integrated web search and fetch kernel, hardened by default; it registers alongside the built-in providers in coexist mode | Factory-bundled plugin (three source packages) |
| Omnivision | Vision bridge: every image is converted to a faithful text description before it reaches the model, so prefix caches stay warm | Factory-bundled plugin |
| ContextManagement | Context cache management (core source-level integration) | Core patch applied directly to the branch source |
| dsh-guard | Installation guard: checks the web profile for known plugin-ecosystem breakage patterns and reports without blocking installation | Single-file guard run by the installer |
| Plugin Registry catalog | First-party plugin directory shipped as the Plugin Center's built-in seed, so discovery works offline; the remote catalog stays the online channel | Offline seed bundled with Plugin Center |

Installation and uninstallation are independent of the main tree and use the same mechanism: all data stays inside the repository's `data/` directory, and the generated `env.ps1` / `env.sh` define `DSH_HOME` and `DSH_BRANCH_HOME` together. The zDSH-go fallback home is `~/.dsh-zdsh-go`, which never collides with the main-tree data directory `~/.dsh-zdsh`; `--clean-legacy` never touches main-tree data.

To relocate the data directory, point `DSH_HOME` in the generated environment loader at another directory — the same mechanism as the main tree.

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
- `env.ps1` / `env.sh` — environment loaders that define `DSH_HOME`, `DSH_BRANCH_HOME`, `DSH_AGENTS_HOME`, and a `dsh` command pointing at the built CLI.

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
