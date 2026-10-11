---
description: "Project-level plugin root for the DeepSeek Harness: discovery from <projectRoot>/.dsh/plugins, host-clamped sandboxes, gating, a trust ledger, and post-boot Cordis layer mounting."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-project-root

English | [中文](README.zh.md)

## Summary

Project-level plugin root for the DeepSeek Harness (S-43 M1 + M2a + M2b). Plugins are discovered from `<projectRoot>/.dsh/plugins/<id>/`, host-clamped, gated, ledger-filtered, and mounted post-boot as a Cordis layer (`ctx.projectPluginLayer`). Every value in this module is a server-side (host) construction: the UI renders it, it never infers it.

## Table of Contents

- [Capabilities](#capabilities)
- [Design basis](#design-basis)
- [Compatibility guard](#compatibility-guard)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="capabilities"></a>
## Capabilities

- **Discovery** (`discoverProjectPlugins`): scans `<root>/.dsh/plugins/<id>/` under the project root found by `findProjectRoot` (nearest ancestor with `.git`, else `cwd`). Symlink/junction entries are rejected with a warning naming the path (A-04); a malformed or incomplete manifest skips the candidate with a warning and never fails the boot (A-05). Candidates are plain objects — nothing is ever serialized to YAML, so `!!js` expression injection has no surface (A-06/A7.4). `pluginDir` is realpathed before use.
- **Host clamping** (`clampProjectPluginSandbox`): the manifest sandbox is an application; the clamp produces the effective sandbox, rejecting (B-01 `fullyAuthorized`/`spawn`/`exec`, B-03 `llm-adapter` capability and any `network.access` other than `none`) or narrowing (memory/timeout capped at `PROJECT_PLUGIN_HOST_CAPS` 512 MiB / 60 s, filesystem `allowedPaths` intersected with the plugin dir, fail-closed) declared values that exceed the project-plugin boundary. M2b grants a declared `process`/`worker` tier (`runtimeTier: 'subprocess'`); `inline` keeps the M2a in-process runtime.
- **Gating** (`gate`): every candidate runs clamp + `LoadGuard.preLoad` (kernel version `0.1.1-rc.2`) + capability rejections, producing `{ accepted, report }` with a full verdict audit trail (`rejected`/`warned`/`mounted`/`mount-failed`).
- **Trust ledger** (`data/project-trusts.json`): durable root × plugin decisions. A missing or corrupt ledger reads as empty (fail closed — nothing mounts until the operator records a decision). Trust is a property of the project root, assigned by the discoverer; a discovered file never self-reports trust. Project plugins never enter the registry `persistedDecisions` mechanism; this ledger is their sole decision store.
- **Post-boot mount isolation** (`mountProjectPlugins` / `createProjectPluginLayer`): the switch (`project-plugins.config.enabled`, no env key) is checked BEFORE any discovery — when off, zero filesystem reads (A-01/A-02). Mounting is serial and post-boot, each `ctx.loader.create` try/catch isolated (B-07); tools are snapshotted before/after each create so newly registered tools are attributed to the plugin that introduced them; origin is recorded BEFORE the governance mirror can see the entry. Project entries never enter the include patch tree.
- **RunGuard wiring**: every mounted plugin gets a watcher (B-08), and every project tool call routes through `runGuard.execute` via the `tools/execute` wrapper (`projectToolWrapper`); non-project tools pass through with zero behavior change (D-01). A `PluginTimeoutError`/`PluginError` maps to a structured `isError` result, never a thrown exception.
- **Subprocess runtime** (`createSubprocessRuntime`, M2b): `process`/`worker` tiers run in a child process or worker thread with an OS boundary. The bootstrap is generated as a string with inlined absolute `file://` URLs (no bare-specifier resolution at the subprocess side); on timeout the subprocess is killed (SIGKILL/`terminate`) so the hung execution body is reclaimed (B-06); memory is enforced via `--max-old-space-size` or Worker `resourceLimits`; only manifest-declared tool names pass the IPC whitelist; the environment is filtered through `deriveSandboxEnvironment` (B-09).
- **Session scope** (`wireSessionScope`, M3/C-03): each project tool is bound to its owning project root; for every live agent whose session `cwd` does not hit that root (`cwdHitsProjectRoot`), the tool is restricted away via `agent.ctx.tools.restrict({ deny: [...] })`, plus an execute-time cwd check in the wrapper as defense-in-depth. New agents are covered by an `agent/created` listener.
- **UI badge**: `runtimeTier` (`in-process` / `subprocess`) is the roster/UI display field; the layer exposes `isSubprocess(pluginId)`, `subprocessEntryIds()`, and origin (`originOf`) for the UI to render.

<a id="design-basis"></a>
## Design basis

The three conditions of the R-S43 red-team ruling are implemented: (1) self-declaration grants nothing automatically — a declared sandbox is an application, the host clamp decides (R-S43 前提 B, fail-closed falls back to whitelist checks); (2) `untrusted` is removed from the sandbox vocabulary, trust lives in the project root ledger alone; (3) every project tool is scoped to its owning project root, enforced both at registration and at execute time.

<a id="compatibility-guard"></a>
## Compatibility guard

`guardProjectRoot()` wraps `guardFeature` from `@deepseek-ai/dsh-compat`: it probes the peer symbols (`cordis:Service`, `governance:LoadGuard`, `tools:defineTool`) before the plugin registers, and returns `false` (never throwing) when any probe fails, so a partially-loaded or upstream-drifted host degrades gracefully. Per COMPAT-DESIGN §4.5 only the presence of core symbols is checked, never their internals.

```ts
import { guardProjectRoot } from '@deepseek-ai/dsh-plugin-project-root/src/compat.ts'

const enabled = await guardProjectRoot()
if (!enabled) {
  // skip registration; do not throw
}
```

<a id="model-experience"></a>
## Model Experience

None, as the package is host-side discovery, clamping, gating, and mounting infrastructure; the project plugins it mounts own every model-facing registration they make.

#### KV Cache effect

None; the trust ledger and the mount pipeline send no provider request and enter no model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **M3 milestones beyond session scope are unscoped** — richer roster projections, per-plugin resource accounting, and ledger migration tooling stay deferred until the S-45 settings milestone settles how operators edit trust decisions.
- **Clamping is a fixed host boundary** — project plugins can never regain capabilities the host clamp removes; packages needing broader capability belong at the user plugin tier instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

#### Future: the M3 milestones beyond session scope

Session scoping (M3/C-03) binds tools to their owning project root; further milestone work — richer roster projections, per-plugin resource accounting, and ledger migration tooling — stays deliberately unscoped until the S-45 settings milestone settles how operators edit trust decisions.

</details>
