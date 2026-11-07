---
description: "Model context for users and maintainers of the Web GUI that names the DeepSeek Harness checkout and GUI URL without letting either change the system prompt."
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-dev-context

English | [中文](README.zh.md)

## Table of Contents

- [Summary](#summary)
- [Use this package](#use-this-package)
- [Frozen legacy wording — maintenance duty](#frozen-legacy-wording--maintenance-duty)
- [Adaptations from the official package](#adaptations-from-the-official-package)
- [Dev Note](#dev-note)

## Summary

`dsh-harness-dev-context` tells an agent running behind the DeepSeek Harness Web GUI where the harness implementation checkout lives, how the GUI relates to "this page", and which URL serves it. The system prompt carries only value-free guidance; the current checkout path and GUI URL arrive as runtime context, so starting the process from another checkout, port, or installation never rewrites a Session's logged system prompt. Sessions whose prompt still embeds those values from earlier releases keep that text verbatim.

## Use this package

The Web runtime's glue plugin (`@deepseek-ai/dsh-web-app`) mounts this plugin from its `surfaceContext` switch, so a one-shot non-interactive layer that turns `surfaceContext` off never mounts it. The plugin itself takes no configuration and activates only where every injected service exists: `systemPrompt`, `sessionProjections`, and the `webApp` service of the Web runtime, so `--help` and non-Web compositions never mount it.

### What the model gets

Two system-prompt sections explain that the checkout differs from the working directory and that "this page" means this GUI, together with the GUI update contract. Two runtime-context lines state the current values: the installation root four directories above this package, and the Web GUI's advertised URL from `webApp.getAdvertisedUrl()`, the same value as `DSH_WEB_URL` and the startup URL.

This fork carries the runtime-context values on its L2 delta channel instead of isolated snapshot messages: a changed value appends a delta that folds into the next real user message's text prefix. The prefix effect is the same — appended after the cached history, never rewriting earlier messages.

### Sessions from earlier releases

Earlier releases embedded both values in the system prompt. When a Session's latest nonempty system prompt still contains those exact paragraphs, the sections repeat them verbatim, old values included, so upgrading and later port or checkout changes leave that Session's prompt byte-identical; the runtime-context lines still give the current values. Text that only resembles an earlier paragraph receives the current guidance.

## Frozen legacy wording — maintenance duty

The `LEGACY_SOURCE` and `LEGACY_WEB_SURFACE` constants in `src/index.ts` are frozen as the previous releases rendered those paragraphs. **Never edit them together with the current guidance** (`HARNESS_SOURCE_PROMPT` / `WEB_SURFACE_PROMPT`): a Session holding the earlier paragraphs stops matching when the frozen text changes, and its next request rewrites its logged first system message. The frozen copy repeats today's guidance on purpose; the two may diverge. When a future release changes the current guidance wording, add the outgoing wording as a new frozen pair instead of editing the existing one.

## Adaptations from the official package

This package ports `dsh-v0.2.2-alpha.3`'s `packages/context/harness-dev-context` verbatim in semantics, with three mechanical adaptations to this fork's runtime:

1. **Synchronous projection registry** — the official alpha.3 registry registers asynchronously and returns a handle (`Promise<Handle>` with `handle.stateOf(session)`); this fork's registry registers synchronously and reads through `sessionProjections.stateOf(session, key)`. `apply` is therefore synchronous, and registration still completes before the section registrations that read it.
2. **Projection key declaration** — this fork's `SessionProjectionStateMap` requires a merge-extensible key entry, declared by module augmentation (`harnessDevLegacyPrompt`); the official alpha.3 host-only overload accepts any string key.
3. **`webApp` contract ownership** — the official web-app bundle owns the `WebApp` interface and Context declaration, and the official bundle patch mounts the plugin as an unconditional row. This fork's type-check graph is acyclic project references and the mount is config-gated in the glue plugin's `surfaceContext` branch, so this package owns the `WebApp` interface and Context declaration, and the glue plugin imports this package to provide the service and mount the plugin.

### Dev Note

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the porting record (CTX-IMP-20261104 T5 evidence: `zDSH-docs/R&D/ctx-imp-20261104/artifacts/T5-evidence.md`). Open maintenance items: the regression checklist for the four-quadrant A1 alignment lives with the spec; the收益量级 estimate (P-D5-7) is a product-gate input, not yet backed by session-level samples.
