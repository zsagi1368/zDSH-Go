# zDSH 增强服务

[English](zdsh.md) | 中文

zDSH 增强服务层在官方 DeepSeek Harness 核心之上新增三个主机侧能力接缝：模型槽位路由（`ctx.modelSlots`）、插件治理（`ctx.pluginGovernance`）与项目插件层（`ctx.projectPluginLayer`）。三者均版本自适应——兼容守卫会探测已安装核心，当与官方表面冲突时自动停用增强。

源接缝：[`packages/llm/model-slots`](../../packages/llm/model-slots)、[`packages/zdsh/plugin-governance-host`](../../packages/zdsh/plugin-governance-host)、[`packages/zdsh/plugin-project-root`](../../packages/zdsh/plugin-project-root)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmodelslots--modelslotregistry"></a>

### `ctx.modelSlots` — `ModelSlotRegistry`

Registry of deployment-level auxiliary-model routes keyed by slot identity. Consumers consult it right before each auxiliary dispatch; every successful resolution with a session sink appends the durable `slots/dispatch` audit record naming the exact route and the tier that produced it. The registry also registers the `llm-model-slots` settings namespace so the settings-mirror tier (user layer) can override the composition base.

```ts cordis-catalog
/**
 * Register one programmatic slot route. Configuration-pinned slots reject
 * registration so a deployment statement cannot be silently replaced at
 * runtime.
 * @param slot - slot identity the route serves.
 * @param route - exact provider/model pair dispatched under the slot.
 * @returns an effect-scoped disposer removing the route again.
 */
register(slot: SlotId, route: ModelRoute): () => void

/**
 * Resolve one auxiliary-model route through the fixed precedence: the
 * slot's own statement, then the deployment default, then the conversation's
 * main-model route. With a session sink, the durable `slots/dispatch`
 * record is appended before the caller dispatches.
 * @param slot - slot identity to resolve.
 * @param input - main-model route fallback and audit sink.
 * @returns the frozen resolution, or `null` when no tier can supply a route.
 */
resolve(slot: SlotId, input: ModelSlotResolveInput = {}): ResolvedModelSlot | null
```

Source: [`packages/llm/model-slots/src/index.ts`](../../packages/llm/model-slots/src/index.ts)

<a id="ctxplugingovernance--plugingovernancegateway"></a>

### `ctx.pluginGovernance` — `PluginGovernanceGateway`

The host governance service. It owns one PluginRegistry and one PluginPersistence bound to this service fiber; status mutations are snapshotted durably before their receipt is returned, so memory and disk never disagree behind an acknowledged call.

```ts cordis-catalog
/**
 * List every registered plugin with its live status and admission state.
 * @returns the point-in-time roster in registration order.
 */
@Remote('list') list(): GovernanceRosterSnapshot

/**
 * Project one registered plugin in full for inspection surfaces.
 * @param request - the plugin to project.
 * @returns the detail, or `plugin-not-found`.
 */
@Remote('get') get(request: PluginIdRequest): GovernanceResult<GovernedPluginDetail>

/**
 * Install a plugin from a local directory or an npm registry source (L3
 * admission pipeline). Local sources must be existing directories with a
 * readable `package.json`; `npm:<name>[@<exact-version>]` sources are
 * resolved against the configured registry, integrity-checked, and
 * extracted into the governance storage area before the same manifest
 * construction runs over them. The constructed manifest is admitted
 * through the governance registry and the roster snapshot persists before
 * the receipt returns.
 *
 * Fail closed: a manifest whose permission posture requests an admission
 * decision (`requiresAdmission`) registers **disabled** unless the approvals
 * ledger already holds a decision, so installed code never runs before the
 * operator approves it; `approve` + `enable` then activate it.
 * @param request - local source directory or `npm:` spec of the plugin.
 * @returns a receipt, or `request-invalid` / `registry-unavailable` /
 * `persistence-failed`.
 */
@Remote('install') async install(request: InstallPluginRequest): Promise<GovernanceResult<GovernanceAcknowledgement>>

/**
 * Uninstall a plugin: unregister it from the governance registry, purge its
 * durable admission state (approvals-ledger entry and queued persisted
 * decision — a later reinstall fails closed instead of inheriting stale
 * grants), and snapshot the registry before the receipt returns. Entries
 * mirrored from the Cordis Loader reappear on the next sync while their
 * module stays mounted in the loader configuration.
 * @param request - the plugin to remove.
 * @returns a receipt, or `plugin-not-found` / `persistence-failed`.
 */
@Remote('uninstall') async uninstall(request: PluginIdRequest): Promise<GovernanceResult<GovernanceAcknowledgement>>

/**
 * Re-enable a previously disabled plugin and snapshot the registry. Plugins
 * whose manifest requests an admission decision stay disabled until
 * `approve` records one — the gate is enforced here on the server, not just
 * in client UI.
 * @param request - the plugin to enable.
 * @returns a receipt, or `plugin-not-found` / `approval-required` /
 * `persistence-failed`.
 */
@Remote('enable') async enable(request: PluginIdRequest): Promise<GovernanceResult<GovernanceAcknowledgement>>

/**
 * Disable a plugin and snapshot the registry. An optional reason enters the
 * registry's own per-plugin record until the next enable re-enables it.
 * @param request - the plugin to disable, with an optional reason.
 * @returns a receipt, or `plugin-not-found` / `persistence-failed`.
 */
@Remote('disable') async disable(request: DisablePluginRequest): Promise<GovernanceResult<GovernanceAcknowledgement>>

/**
 * Report aggregate and per-plugin health, including each plugin's own probe
 * verdict when it declares one.
 * @returns the aggregated report over the current roster.
 */
@Remote('health') health(): GovernanceHealthReport

/**
 * Record the operator's admission decision for a plugin whose manifest
 * requests confirmation. The decision survives restarts in the approvals
 * ledger and is reported by `list` and `get`.
 * @param request - the plugin to approve.
 * @returns a receipt, or `plugin-not-found` / `persistence-failed`.
 */
@Remote('approve') approve(request: PluginIdRequest): GovernanceResult<GovernanceAcknowledgement>

/**
 * Snapshot which plugins are currently enabled or disabled under a preset
 * name. Statuses other than active/disabled are runtime facts rather than
 * operator decisions and stay out of presets.
 * @param request - name of the preset to write.
 * @returns a receipt, or `preset-already-exists` / `request-invalid` /
 * `persistence-failed`.
 */
@Remote('presetSave') presetSave(request: PresetNameRequest): GovernanceResult<GovernanceAcknowledgement>

/**
 * Apply a stored preset: re-enable or disable each listed plugin against
 * the live registry. Entries naming unknown plugins are reported untouched.
 * @param request - name of the preset to apply.
 * @returns applied and unknown ids, or `preset-not-found` /
 * `request-invalid` / `persistence-failed`.
 */
@Remote('presetLoad') async presetLoad(request: PresetNameRequest): Promise<GovernanceResult<PresetApplicationReport>>

/**
 * Delete one stored preset. The live registry is untouched.
 * @param request - name of the preset to delete.
 * @returns a receipt, or `preset-not-found` / `request-invalid` /
 * `persistence-failed`.
 */
@Remote('presetDelete') presetDelete(request: PresetNameRequest): GovernanceResult<GovernanceAcknowledgement>

/**
 * Read the durable factory preinstall result ledger (§1.4): one row per seed
 * entry recording whether it installed, was skipped, or failed, plus the
 * `userUninstalled` tombstone. The plugin-center discovery-install hub
 * consumes this alongside the catalog. A read-only, synchronous projection
 * of the on-disk ledger — it triggers no install work and never fails; an
 * absent ledger reports an empty result set.
 * @returns the point-in-time preinstall report.
 */
@Remote('preinstallReport') preinstallReport(): PreinstallReport

/**
 * Await the in-flight or last factory preinstall pass to settle. Test seam
 * mirroring {@link syncMountedPlugins}: boot calls the pass fire-and-forget,
 * so a caller that needs the durable outcome calls this to join it. When the
 * boot pass was gated off (`factorySeeds`, SYNC-P3-CFIX) nothing is in flight
 * and this seam runs the pass itself — the awaited outcome is one complete
 * pass either way.
 * @returns when the current pass has committed or decided to write nothing.
 */
settlePreinstall(): Promise<void>

/**
 * Mirror the Cordis Loader's currently mounted plugin entries into the
 * governed registry, so the roster and the plugin-manager UI report real
 * production data instead of an empty list. Each entry is wrapped through
 * the governance Cordis adapter in mirror mode: lifecycle stays owned by
 * Cordis, and the operator's mount decision in the loader configuration
 * counts as the admission decision. One entry failing to wrap or register
 * never blocks the rest; already-mirrored ids are skipped on re-runs.
 *
 * Runs once at service init and is re-triggered by every `list`/`health`
 * read so entries mounted after this service can still appear.
 * @returns when one full sync pass has settled (also a test seam).
 */
async syncMountedPlugins(): Promise<void>
```

Source: [`packages/zdsh/plugin-governance-host/src/index.ts`](../../packages/zdsh/plugin-governance-host/src/index.ts)

<a id="ctxprojectpluginlayer--projectpluginlayer"></a>

### `ctx.projectPluginLayer` — `ProjectPluginLayer`

The host-side project plugin layer service.

```ts cordis-catalog
/**
 * Mount accepted candidates, one by one, isolated per entry.
 * @param accepted - candidates that passed the discovery gate.
 * @returns mount result with successfully mounted entry ids and full audit trail.
 */
mount(accepted: ProjectPluginCandidate[]): Promise<MountResult>

/**
 * Origin of one mounted loader entry id.
 * @param entryId - loader entry id returned by mount.
 * @returns the origin record, or `undefined` when the id is unknown.
 */
originOf(entryId: string): ProjectPluginOrigin | undefined

/**
 * The guarded manifest of one mounted loader entry id.
 * @param entryId - loader entry id returned by mount.
 * @returns the guarded manifest, or `undefined` when the id is unknown.
 */
guardedManifestOf(entryId: string): PluginManifest | undefined

/**
 * Canonical manifest id owning one tool name.
 * @param toolName - tool name registered by a project plugin.
 * @returns the manifest id that owns the tool, or `undefined` when unattributed.
 */
toolOwnerOf(toolName: string): string | undefined

/**
 * Project root owning one manifest id.
 * @param pluginId - manifest id of a mounted project plugin.
 * @returns the project root path, or `undefined` when unknown (M3 scope check).
 */
projectRootOf(pluginId: string): string | undefined

/**
 * Whether one manifest id runs in a subprocess.
 * @param pluginId - manifest id of a mounted project plugin.
 * @returns `true` when the plugin runs in an M2b subprocess (process/worker tier).
 */
isSubprocess(pluginId: string): boolean

/**
 * The subprocess runtime of one manifest id.
 * @param pluginId - manifest id of a mounted project plugin.
 * @returns the subprocess runtime, or `undefined` when the plugin runs inline.
 */
subprocessOf(pluginId: string): SubprocessRuntime | undefined

/**
 * Loader entry ids of subprocess-tier project plugins (M2b).
 * These entries have NO loader row — their tools are host-side proxies — so
 * the governance mirror must enumerate them separately from `loader.entries()`.
 * @returns an array of subprocess-tier loader entry ids.
 */
subprocessEntryIds(): string[]

/** Remove the tools/execute wrapper and drop all watchers and subprocesses. */
dispose(): void
```

Source: [`packages/zdsh/plugin-project-root/src/plugin.ts`](../../packages/zdsh/plugin-project-root/src/plugin.ts)
<!-- END GENERATED cordis-surface -->
