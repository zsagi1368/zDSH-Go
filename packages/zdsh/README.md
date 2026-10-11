---
description: "The zdsh group map: the fork's self-developed base — the version-adaptive compat shim, the host-side governance kernel and its host service face, the project-level plugin root, and the private factory bundle pinning every factory-seeded plugin."
kind: "package-group"
---

# packages/zdsh

English | [中文](README.zh.md)

## Summary

The zdsh group is the namespace of the zDSH self-developed base: every package this fork adds lives under `packages/zdsh/*`. `dsh-compat` is the only layer probing the official core API shape; feature packages gate registration through it instead of throwing on a drifted boot. `plugin-governance` and `plugin-governance-host` own the governance kernel and host service face for third-party extensions. `plugin-project-root` discovers project plugins, clamps sandboxes, gates via a durable trust ledger, and mounts them post-boot as an isolated Cordis layer. `factory-bundle` pins every factory-seeded plugin's git URL and full commit, so one `pnpm install` lands each artifact in the workspace closure.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`dsh-compat/`](dsh-compat/README.md) | Dynamic API-shape probing (`probeSymbol`), feature guards (`guardFeature`), and the process-level compat roster; zero runtime dependencies | — (process-level roster) |
| [`plugin-governance/`](plugin-governance/README.md) | Governance spec and kernel: spec, registry, guards, sandbox, Cordis adapter, and persistence | `ctx.pluginGovernance` (host remote via `plugin-governance-host`) |
| [`plugin-governance-host/`](plugin-governance-host/README.md) | Host service face: governance gateway (`PluginGovernanceGateway`), remote vocabulary (`/types` `/typert` `/remote`), and the factory seed preinstaller | — (host service) |
| [`plugin-governance-ui/`](plugin-governance-ui/README.md) | Governance tab UI (client piece): roster badges, lifecycle and admission actions, health counts, and presets, projected through the `pluginGovernance` remote | — (client slots piece) |
| [`plugin-project-root/`](plugin-project-root/README.md) | Project-level plugin discovery, host clamping, gating, trust ledger, and post-boot layer mounting | `ctx.projectPluginLayer` |
| [`factory-bundle/`](factory-bundle/README.md) | Private manifest: git URL + full commit pins for the eight factory-seeded plugins (`@deepseek-ai/zdsh-factory-bundle`); unpublished, no executable source | — (dependency manifest) |

-----

<a id="related-documentation"></a>
## Related documentation

- [zDSH enhanced services subsystem](../../docs/subsystems/zdsh.md) — the plugin governance gateway, project plugin layer, and factory preinstall spectrum these packages provide, with the guard and sandbox semantics.

-----
