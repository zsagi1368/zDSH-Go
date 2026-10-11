---
description: "Private factory artifact bundle: pins the git URL + commit for every zDSH factory-seeded plugin so one pnpm install lands each artifact in the workspace closure for the governance preinstall executor."
kind: "package-reference"
---

# @deepseek-ai/zdsh-factory-bundle

English | [中文](README.zh.md)

## Summary

Declare every plugin the zDSH factory seeds at first boot as a git URL + full commit pin; one `pnpm install` lands each artifact in this package's `node_modules` closure, and the governance `SeedPreinstaller` admits it in place through the existing `local:` install channel. Use it when you add or update a factory-seeded plugin: put one `dependencies` row here and a matching `zdsh-factory/seed.json` entry. This package never moves, copies, or deletes artifacts; each row must carry a 40-hex commit pin and a Gate-P probe. It currently pins eight artifacts; the boot posture of each is recorded in Known Limitations.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Add a `<package-name>: git+https://…#<40-hex commit>` row under `dependencies`, then run `pnpm install`; the artifact lands under this package's `node_modules` closure. Point a matching `zdsh-factory/seed.json` entry's `source` at the resolved directory. The pilot probe lives in `tests/gate-p.spec.ts`.

## Model Experience

None, as this is a private dependency manifest that registers nothing model-facing.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- No runtime invariant companion is published; this package is a private dependency manifest with no executable source and no mutable runtime state to assert invariants over.
- A git dependency clones the repository root, so `dsh-webstack-verticals`, `dsh-webstack-bridge` and `dsh-webstack` all resolve to the WebStack monorepo and the seed's `local:` sources point at its `packages/verticals`, `packages/bridge` and `packages/webstack` subdirectories respectively; `dsh-omnivision`, `dsh-filehub`, `dsh-plugin-center`, `dsh-autopilot` and `zdsh-workbench` are single-package repositories, so their sources point straight at `node_modules/<pkg>`.
- Eight artifacts are pinned (verticals + omnivision + bridge + filehub + plugin-center + autopilot + webstack + workbench); the boot posture spectrum is six mounted (omnivision + bridge + filehub + plugin-center + webstack + workbench — filehub/plugin-center flipped `enabledAtBoot: true` by TC-B4-RA-2 after the full R-A preconditions went green; webstack was seeded boot-enabled by TC-B4-W3 per the W-DEC ruling, only after the W1/W1b/W1c source-fix chain went green; workbench was seeded boot-enabled by TC-O3 per the user's O-3 ruling, only after the phase-1 source modernization chain went green — never seed a boot-enabled row ahead of its source fixes) and two skipped (verticals, opt-in per its own package docs; autopilot, product-design default-off per ADJ-3); the remaining intake plugins are added in later batches.
- SSRF duty split (dual track): requests flowing through the webstack fetch/render path are guarded by the plugin's own `checkTarget` gate (`safety/ssrf.ts`, fail-closed on the resolved IP); requests flowing through the host's built-in http fetch path are guarded by the platform's four-gate chain (policy/network/provider per-hop + bounded body). The bridge's JS-render fallback reuses the plugin gate through its `dsh-webstack` peer import (fail-closed when the peer is absent).

### Dev Note

Adding a dependency here is a supply-chain change: it must carry a 40-hex commit pin (never a branch or floating range), and every new entry needs a matching `zdsh-factory/seed.json` row and a Gate-P probe.
