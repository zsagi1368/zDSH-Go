---
description: "Cordis service giving every auxiliary side-task model call one shared routing vocabulary: pinned slots, a deployment fallback, and durable dispatch attribution."
kind: "package-reference"
---

# `@deepseek-ai/dsh-model-slots`

English | [中文](README.zh.md)

## Summary

Cordis service (`ctx.modelSlots`) that gives every auxiliary side-task model call one shared routing vocabulary. A deployment pins an exact `provider`/`model` route per built-in slot (`title`, `compaction.summarize`) with a `fallback` default; every value must be a complete pair, and ids outside the built-in vocabulary fail at boot. `resolve(slot, input)` picks the first available of slot, deployment default, or the caller's main-model route, returning `null` when none applies. Each successful resolve with a `session` sink appends a durable log-only `slots/dispatch` event attributing the call to the route actually used.

## Table of Contents

- [Version adaptation (compat guard)](#version-adaptation-compat-guard)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="version-adaptation-compat-guard"></a>
## Version adaptation (compat guard)

The feature probes its peer surfaces through `@deepseek-ai/dsh-compat`'s `guardFeature` (`guardModelSlots` in `src/compat.ts`) and books the verdict in the process-level audit roster:

- `cordis:Service` — `@deepseek-ai/cordis` must export a callable `Service`.
- `settings:forms` — `@deepseek-ai/dsh-settings` must export the entry-derived `SettingsForms` face (`describe`/`update`/`mutate` on its prototype). It replaced the retired `SettingsProvider` registration surface and is the face a user-layer slot override is written through.

A failed probe logs a warning and returns `false` with an attributed roster reason; the registry itself registers on every host and keeps serving the composition configuration, so a host without that face loses only the settings-writable user layer. The guard never throws and never breaks the host tree.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumers that resolve their auxiliary dispatch route here: this service only selects the provider/model pair a side-task request uses, while request assembly and the provider adapters own everything the model sees.

#### KV Cache effect

The resolution itself sends no request and changes no context. The selected route decides which provider cache an auxiliary call lands in: a stable per-slot statement keeps successive auxiliary requests on one warm route, while an absent statement follows the conversation's main-model route and shares its cache behavior. A configuration change re-points later auxiliary calls and invalidates whatever prefix reuse the previous route held; the `slots/dispatch` record is log-only and never enters model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Slot ids are a closed built-in set** — deployments cannot name custom slots yet because the vocabulary grows only with reviewed consumers; adding `vision` or `plan` slots is deferred until their routing integration lands.
- **The user layer is the entry's own Config** — slot routes come from the `llm-model-slots` profile row, and an edit through the settings face writes the user layer into that same entry: both policy fields are volatile, so the write commits into the running entry and later auxiliary calls re-point without a remount. The Models page's slot block and the settings mirror address that entry id only; a deployment row mounted under another id still serves its composition config but carries no settings-writable user layer. Project-level overrides remain out of scope pending security review.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

#### Future: finer user-layer policy semantics

`slots` and `fallback` are wholesale volatile fields: a path-addressed settings edit merges into the running entry, a wholesale section replace rewrites the whole policy, and a rejected policy warns once and keeps the previous routes. Whether a finer per-slot merge tier belongs above the composition base, and how project-level overrides would compose with it, remain undecided.

</details>
