/**
 * 诊断：`web_backend_status` 工具与对话请求触发的引擎体检（W-B-113/114 /
 * F-010 / F-109）。无副作用探测纪律：只读注册表运行时状态、缓存计数与能力
 * 位图——绝不发网络探针、不触发登录态刷新/远端写入/守护进程拉起。
 *
 * 结构与渲染分离：runDoctor 产出机器可读报告（工具 canonical 值直接复用），
 * renderDoctor 把报告渲染为双语文本（处方按档位派生）。
 *
 * @module webstack/diag/doctor
 */

import type { SearchCache } from '../cache/store.ts'
import { type DoctorI18nKey, doctorText } from '../i18n/doctor.ts'
import type { Locale } from '../i18n/index.ts'
import type { EngineRegistry } from '../kernel/registry.ts'
import type { CapabilityBitmap, TierMode } from '../kernel/types.ts'

/** doctor 四态词汇保留（历史契约；当前报告的引擎态由 registry 快照派生）。 */
export const DOCTOR_HEALTH_STATES = ['missing', 'broken', 'timeout', 'error'] as const

export type DoctorHealthState = (typeof DOCTOR_HEALTH_STATES)[number]

/** 报告中的单引擎条目（与 registry.EngineStatusEntry 对齐 + 剩余冷却毫秒）。 */
export interface DoctorEngineEntry {
  readonly id: string
  readonly state: 'ok' | 'cooldown' | 'unwired'
  /** 冷却剩余毫秒（cooldown 态必带；其余缺席）。 */
  readonly cooldownRemainingMs?: number
  /** 最近一次失败错误码（失败过且未恢复时携带）。 */
  readonly lastCode?: string
}

/** 桥接卫星在报告中的三态词汇（W9：在线 / 离线；缺席 = 不输出该节）。 */
export type DoctorBridgeState = 'online' | 'offline'

/** 垂直频道在报告中的三态词汇（W9）：开 / 关 / 开但卫星包缺失。 */
export type DoctorVerticalState = 'on' | 'off' | 'pack-missing'

/** 机器可读体检报告（web_backend_status 的 canonical 值同形）。 */
export interface DoctorReport {
  readonly tier: TierMode
  readonly engines: readonly DoctorEngineEntry[]
  readonly cache: {
    readonly hits: number
    readonly misses: number
    readonly size: number
  }
  /** 浏览器桥接卫星状态（W9 加法式增补；缺席 = 装配层未上报，不渲染该行）。 */
  readonly bridge?: DoctorBridgeState
  /** 垂直频道状态（W9 加法式增补；缺席 = 不渲染该行）。 */
  readonly vertical?: DoctorVerticalState
}

export interface DoctorDeps {
  readonly bitmap: CapabilityBitmap
  readonly tier: TierMode
  readonly registry: EngineRegistry
  readonly cache: SearchCache
  /**
   * 配置面已知但未注册的引擎 id（如 settings 里启用而接线缺失者）→
   * 报告中以 unwired 态列出；缺省不合并。
   */
  readonly configuredEngineIds?: readonly string[]
  /** 浏览器桥接卫星是否在线（装配层探测结果）；缺省不输出桥接行。 */
  readonly bridgeOnline?: boolean
  /** 垂直频道当前状态；缺省不输出垂直行。 */
  readonly vertical?: DoctorVerticalState
}

/**
 * 编排一次体检：registry 状态快照 ∪ 配置面已知引擎 → 统一条目；
 * 缓存计数直读；桥/垂类状态透传。全程本地数据，零副作用。
 */
export function runDoctor(deps: DoctorDeps): DoctorReport {
  const now = Date.now()
  const snapshot = deps.registry.statusSnapshot()
  const engines: DoctorEngineEntry[] = []

  for (const [id, entry] of Object.entries(snapshot)) {
    if (entry.state === 'cooldown' && entry.cooldownUntil !== undefined) {
      engines.push({
        id,
        state: 'cooldown',
        cooldownRemainingMs: Math.max(0, entry.cooldownUntil - now),
        ...(entry.lastCode === undefined ? {} : { lastCode: entry.lastCode }),
      })
      continue
    }
    engines.push(
      entry.lastCode === undefined
        ? { id, state: entry.state }
        : { id, state: entry.state, lastCode: entry.lastCode },
    )
  }

  for (const id of deps.configuredEngineIds ?? []) {
    if (snapshot[id] === undefined) {
      engines.push({ id, state: 'unwired' })
    }
  }

  const stats = deps.cache.stats()
  return {
    tier: deps.tier,
    engines,
    cache: { hits: stats.hits, misses: stats.misses, size: stats.size },
    ...(deps.bridgeOnline === undefined
      ? {}
      : { bridge: deps.bridgeOnline ? 'online' : 'offline' }),
    ...(deps.vertical === undefined ? {} : { vertical: deps.vertical }),
  }
}

/** 档位 → 处方键（数据化规则单一来源）。 */
export function prescriptionKeyFor(tier: TierMode): DoctorI18nKey {
  return `webstack.doctor.rx.${tier}`
}

/** 用 %s 占位符按序填充模板（只替换实参个数次，多余占位原样保留）。 */
function fill(template: string, args: readonly (string | number)[]): string {
  let out = template
  for (const arg of args) {
    out = out.replace('%s', String(arg))
  }
  return out
}

/**
 * 渲染双语体检文本：档位说明 + 处方 + 引擎状态行 + 缓存统计。
 * 纯函数；locale 未知值安全回落中文。
 */
export function renderDoctor(report: DoctorReport, locale: Locale = 'zh'): string {
  const lines: string[] = []
  lines.push(doctorText('webstack.doctor.header', locale))
  lines.push(doctorText(`webstack.doctor.tier.${report.tier}`, locale))
  lines.push(doctorText(prescriptionKeyFor(report.tier), locale))

  for (const engine of report.engines) {
    if (engine.state === 'cooldown') {
      lines.push(
        fill(doctorText('webstack.doctor.engine.cooldown', locale), [
          engine.id,
          Math.ceil((engine.cooldownRemainingMs ?? 0) / 1000),
        ]),
      )
    } else if (engine.state === 'unwired') {
      lines.push(fill(doctorText('webstack.doctor.engine.unwired', locale), [engine.id]))
    } else {
      lines.push(fill(doctorText('webstack.doctor.engine.ok', locale), [engine.id]))
    }
    if (engine.lastCode !== undefined) {
      lines.push(fill(doctorText('webstack.doctor.engine.last-code', locale), [engine.lastCode]))
    }
  }

  // W10 审计加固（UX）：「全冷却」场景补一条聚合处方——逐引擎倒计时只回答
  // 「多久恢复」，不回答「我该做什么」；全部条目皆 cooldown 时才触发。
  if (report.engines.length > 0 && report.engines.every(engine => engine.state === 'cooldown')) {
    lines.push(doctorText('webstack.doctor.rx.all-cooldown', locale))
  }

  // W9 加法式增补：桥接卫星与垂直频道状态行（缺席不渲染，报告向后兼容）。
  if (report.bridge !== undefined) {
    lines.push(
      doctorText(
        report.bridge === 'online'
          ? 'webstack.doctor.bridge.online'
          : 'webstack.doctor.bridge.offline',
        locale,
      ),
    )
  }
  if (report.vertical !== undefined) {
    const verticalKey =
      report.vertical === 'on'
        ? 'webstack.doctor.vertical.on'
        : report.vertical === 'off'
          ? 'webstack.doctor.vertical.off'
          : 'webstack.doctor.vertical.pack-missing'
    lines.push(doctorText(verticalKey, locale))
  }

  lines.push(
    fill(doctorText('webstack.doctor.cache.stats', locale), [
      report.cache.hits,
      report.cache.misses,
      report.cache.size,
    ]),
  )
  return lines.join('\n')
}
