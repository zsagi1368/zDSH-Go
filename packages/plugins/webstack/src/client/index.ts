/**
 * dsh-webstack 客户端半（浏览器侧）。
 *
 * 职责（对齐 dsh-at-file 的薄壳模式）：
 * - 注册双语字典（webstack.card / webstack.toggle 两个命名空间）；
 * - 经 keyed slot `settings.plugin.item` 注册设置卡，key = 设置命名空间
 *   `webstack`（与官方插件卡同构：keyed 派发按命名空间寻址）；
 * - 经列表槽 `conversation.input.left` 注册联网模式三态按钮
 *   （off/on/ask，会话级）。
 *
 * 降级梯（装配期一次性判定）：`settingsScope` 服务可达 → 绑定 `webstack`
 * 命名空间，快照驱动状态机，writable 时开放暂存编辑与写入；服务缺席或
 * 快照不可写 → 只读展示卡 / 本地态按钮。类型面上，zDSH-go 工作区把
 * dsh-client-ui-settings-plugins 列为 devDep（workspace:^），`settings.plugin.item`
 * 的 SlotMap 声明由权威包经 type-only 导入并入；运行时仍不依赖该包。
 *
 * @module webstack/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
// 类型-only：把 conversation.input.* 的 SlotMap 声明并入本编译程序。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// 类型-only：ctx.slots 注册表类型由 ui-renderer 提供（alpha.4 起）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// 类型-only：把 settings.plugin.item 的权威 SlotMap 声明并入本编译程序。
// （zDSH-go 适配：上游因此包不在 devDeps 而本地重声明同 id slot，与
// gen-client-catalog 的重复声明检查冲突；此处改为依赖权威声明，
// type-only 导入运行时零副作用，降级梯不变。）
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// 类型-only：alpha.4 起 client 侧快照式 SettingsScope 契约由 ui-settings 提供
// （原 dsh-client-runtime/client 导出，包删除后迁移至此；getSnapshot/subscribe/set 面不变）。
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SearchLayer, SessionOnlineMode } from '../kernel/types.ts'
import { DEFAULT_SETTINGS } from '../settings/schema.ts'
import {
  cleanDraft,
  type DraftEvent,
  type DraftState,
  diffToWrites,
  reduceDraft,
  shapeFromSection,
  type WebstackSettingsShape,
} from './draft-state.ts'
import { OnlineModeToggle } from './input-toggle.tsx'
import { CARD_NS, cardEn, cardZh, TOGGLE_NS, toggleEn, toggleZh } from './locale.ts'
import { type CardViewState, WebstackSettingsCard } from './settings-card.tsx'

/** 必需服务：槽注册表与字典服务。settingsScope 为软依赖（缺席降级），不入清单。 */
export const inject = ['slots', 'locale']

/** 本插件的设置命名空间（宿主 settings.yaml 的 `webstack:` 段）。 */
const SETTINGS_NS = 'webstack'

// zDSH-go adaptation: upstream locally re-declared the `settings.plugin.item`
// slot shape because @deepseek-ai/dsh-client-ui-settings-plugins was not in its
// devDeps. In this workspace the authoritative declaration IS available
// (devDep, workspace:^), and gen-client-catalog rejects duplicate SlotMap ids —
// so the local merge block was removed in favor of the authoritative one.

/** settingsScope 服务暴露的最小结构面（运行时结构探测用）。 */
interface ScopeBinderFace {
  bind: (spec: { namespace: string }) => unknown
}

function defaultShape() {
  return {
    enabled: DEFAULT_SETTINGS.enabled,
    layer: DEFAULT_SETTINGS.search.layer as SearchLayer,
    autoFallback: DEFAULT_SETTINGS.search.autoFallback,
    maxResults: DEFAULT_SETTINGS.search.maxResults,
    fusionEnabled: DEFAULT_SETTINGS.search.fusion.enabled,
    timeDecayHalfLifeH: DEFAULT_SETTINGS.search.fusion.timeDecayHalfLifeH,
    authorityBoost: DEFAULT_SETTINGS.search.fusion.authorityBoost,
    diversityDiscount: DEFAULT_SETTINGS.search.fusion.diversityDiscount,
    maxContentChars: DEFAULT_SETTINGS.fetch.maxContentChars,
    ssrfExemptsText: '',
  }
}

/** 结构探测 settingsScope 服务；访问未装载服务的属性会抛错而非 undefined。 */
function peekScopeBinder(ctx: ClientContext): ScopeBinderFace | undefined {
  try {
    const candidate = (ctx as unknown as Record<string, unknown>).settingsScope
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof (candidate as ScopeBinderFace).bind === 'function'
    ) {
      return candidate as ScopeBinderFace
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 会话在线模式字面值守卫。 */
function asOnlineMode(value: unknown): SessionOnlineMode | undefined {
  return value === 'off' || value === 'on' || value === 'ask' ? value : undefined
}

/**
 * 客户端组合入口：字典 + 设置卡 + 联网按钮。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(CARD_NS, { zh: cardZh, en: cardEn }),
    'dsh-webstack: card dictionaries',
  )
  ctx.effect(
    () => ctx.locale.register(TOGGLE_NS, { zh: toggleZh, en: toggleEn }),
    'dsh-webstack: toggle dictionaries',
  )

  // 视图快照：状态机相 + 降级标记。初始走默认基线（降级展示形态）；
  // scope 首个 accepted section 到达后由 load 事件整体替换基线。
  const view = createSnapshotStore<CardViewState>({
    machine: cleanDraft(defaultShape()),
    readOnly: true,
    scopeStatus: 'unbound',
  })

  const dispatch = (event: DraftEvent): void => {
    view.set({ ...view.getSnapshot(), machine: reduceDraft(view.getSnapshot().machine, event) })
  }

  const binder = peekScopeBinder(ctx)
  let scope: SettingsScope<Record<string, unknown>> | undefined
  if (binder !== undefined) {
    try {
      scope = binder.bind({ namespace: SETTINGS_NS }) as SettingsScope<Record<string, unknown>>
    } catch {
      scope = undefined
    }
  }

  /** scope 快照 → 视图同步（只读位随 writable 翻转）。 */
  const syncFromScope = (): void => {
    if (scope === undefined) return
    const snapshot = scope.getSnapshot()
    const machine = reduceDraft(view.getSnapshot().machine, {
      type: 'load',
      value: shapeFromSection(snapshot.value, defaultShape()),
    })
    view.set({
      machine,
      readOnly: !snapshot.writable,
      scopeStatus: snapshot.status === 'unavailable' ? 'unavailable' : snapshot.status,
    })
  }

  if (scope !== undefined) {
    syncFromScope()
    ctx.effect(() => scope.subscribe(syncFromScope), 'dsh-webstack: settings scope mirror')
  }

  const editField = (
    field: keyof WebstackSettingsShape,
    value: string | number | boolean,
  ): void => {
    dispatch({ type: 'edit', field, value })
  }

  const save = (): void => {
    if (scope === undefined) return
    const before = view.getSnapshot()
    if (before.readOnly || before.machine.phase !== 'dirty') return
    dispatch({ type: 'save' })
    const saving = view.getSnapshot().machine
    if (saving.phase !== 'saving') return
    const writes = diffToWrites(saving.draft, saving.committed)
    const settle = writes.reduce(
      (chain, write) => chain.then(() => scope.set(write.field, write.value)),
      Promise.resolve(),
    )
    void settle.then(
      () => dispatch({ type: 'saveSuccess' }),
      () => {
        dispatch({ type: 'saveFailure' })
        syncFromScope()
      },
    )
  }

  const discard = (): void => {
    dispatch({ type: 'discard' })
  }

  // ---- 设置卡：keyed slot，key = 设置命名空间 ------------------------------
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: SETTINGS_NS,
        locale: CARD_NS,
        inject: () => ({
          hooks: { webstackCard: view as SnapshotStore<CardViewState> },
          editField,
          save,
          discard,
        }),
      },
      WebstackSettingsCard,
    ),
  )

  // ---- 联网模式三态按钮：composer 工具行左端 ------------------------------
  // 写入通道仅在 scope 可写时接通；否则组件退化为会话内本地态。
  const onlineWritable = (): boolean =>
    scope?.getSnapshot().writable === true &&
    scope.getSnapshot().status === 'ready' &&
    view.getSnapshot().readOnly === false

  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'webstack-online-mode',
        order: 30,
        locale: TOGGLE_NS,
        inject: () => ({
          initial: asOnlineMode(
            (scope?.getSnapshot().value as { mode?: { sessionOnline?: unknown } } | undefined)?.mode
              ?.sessionOnline,
          ),
          requestChange: onlineWritable()
            ? (next: SessionOnlineMode) => {
              void scope?.set('mode.sessionOnline', next)
              return true
            }
            : undefined,
        }),
      },
      OnlineModeToggle,
    ),
  )
}

// SettingsScope 契约面（getSnapshot/subscribe/set）由 dsh-client-runtime/client
// 导出，syncFromScope/save 即按其语义实现。
export type { DraftState }
