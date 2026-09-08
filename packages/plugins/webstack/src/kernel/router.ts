/**
 * 层级路由与复杂度分档（W-B-12/14）：native/free/api/selfhosted/mcp 选层 +
 * simple/medium/complex 分档定引擎集合宽度与是否融合。
 * 纯函数、无状态：同一 (config, hints, band) 输入永远得到同一计划——
 * 计划进入缓存键维度（engineSet），确定性是缓存正确性的前提。
 *
 * @module webstack/kernel/router
 */

// hints 参数位为契约签名保留（W-B-15 软偏好下推属后续波次）；下划线前缀即弃用标记。
// KEYED_ENGINE_IDS 为 keyed 引擎 id 的单一事实源（engines/engine.ts），api 层
// 候选池据此展开——注册表按 tier 过滤时二者天然一致。
import { KEYED_ENGINE_IDS } from '../engines/engine.ts'
import type { ComplexityBand, SearchHints, SearchLayer } from './types.ts'
import { SEARCH_LAYERS } from './types.ts'

/** 层词汇守卫：未知配置值安全回落 `free`（开箱默认层）。 */
export function normalizeLayer(value: string | undefined): SearchLayer {
  return (SEARCH_LAYERS as readonly string[]).includes(value ?? '')
    ? (value as SearchLayer)
    : 'free'
}

/**
 * 各层的候选引擎 id 池（注册序即优先序；mcp 池随配置动态注入，见
 * {@link RouterConfigSnapshot.layerPools}）。
 */
export const LAYER_ENGINE_POOL: Readonly<Record<SearchLayer, readonly string[]>> = Object.freeze({
  native: ['native'],
  free: ['ddg', 'bing-lite'],
  api: [...KEYED_ENGINE_IDS],
  selfhosted: ['searxng'],
  mcp: [],
})

/** X/Twitter 垂直腿的触发词矩阵：站点指称（x.com/twitter.com）或「推特/X」词。 */
const VERTICAL_X_PATTERN =
  /(?:^|\s)(?:site:)?(?:www\.)?(?:x|twitter)\.com(?:\s|$)|推特|(?:^|\s)[xX](?:\s|$)/

/**
 * 确定性判定：hints 是否指向 X/Twitter 垂直域（纯函数、不打网）。
 * - `site:` 限域落在 x.com/twitter.com 及子域 → 出手；
 * - hard/soft 片段含站点指称 → 出手；
 * - 归并主题词含「推特」或独立词「X」→ 出手（装配契约的中文触发词）。
 */
export function hintsTargetVerticalX(hints: SearchHints): boolean {
  const siteFilter = hints.siteFilter?.toLowerCase().replace(/\.+$/, '')
  if (
    siteFilter === 'x.com' ||
    siteFilter === 'twitter.com' ||
    (siteFilter?.endsWith('.x.com') ?? false) ||
    (siteFilter?.endsWith('.twitter.com') ?? false)
  ) {
    return true
  }
  const corpus = [hints.topic ?? '', ...hints.hard, ...hints.soft].join(' ')
  return VERTICAL_X_PATTERN.test(` ${corpus} `.toLowerCase())
}

/** 查询操作符字形（`site:` 与引号短语）——带操作符的查询不再视为 simple。 */
const OPERATOR_HINT = /\bsite:|["“”]/

/**
 * 查询特征 → 复杂度分档（冻结规则）：
 * - 长度 ≤16 且不含操作符 → simple；
 * - 长度 ≤48 → medium；
 * - 其余 → complex。
 */
export function estimateBand(query: string): ComplexityBand {
  const q = query.trim()
  if (q.length <= 16 && !OPERATOR_HINT.test(q)) return 'simple'
  if (q.length <= 48) return 'medium'
  return 'complex'
}

/** 路由器消费的配置快照（操作起点固定，W-B-74）。 */
export interface RouterConfigSnapshot {
  /** 默认路由层。 */
  readonly layer: SearchLayer
  /** false = 只用首选单引擎，不做候选展开。 */
  readonly autoFallback: boolean
  /** 多引擎结果的 RRF 融合总开关。 */
  readonly fusionEnabled: boolean
  /** 复杂度分档路由开关；关闭时按 medium 固定宽度取池。 */
  readonly complexityRouting: boolean
  /**
   * 层候选池覆盖（W9）：键 = 路由层，值 = 该层的实际接线引擎 id 序列。
   * 目前用于 mcp 层——池随 `mcpServers` 配置动态生成，静态表无法表达；
   * 缺席层回落 {@link LAYER_ENGINE_POOL}。
   */
  readonly layerPools?: Partial<Record<SearchLayer, readonly string[]>>
  /**
   * 垂直腿引擎 id（W9，实验性卫星供给）：非空且 hints 命中垂直触发矩阵时
   * 追加到计划尾部（加发该腿，不影响首选序）。
   */
  readonly verticalEngineIds?: readonly string[]
}

/** 一次搜索的执行计划（aggregator 与缓存键的共同输入）。 */
export interface SearchPlan {
  readonly layer: SearchLayer
  /** 参与本次的引擎 id（顺序即 fallback 候选顺序）。 */
  readonly engineIds: readonly string[]
  /** 是否对多引擎结果做 RRF 轻量融合。 */
  readonly fusion: boolean
}

/**
 * 由配置快照 + 分档产出执行计划：
 * - simple → 池首 1 个；medium → 前 2 个；complex → 全池 + fusion；
 * - autoFallback=false → 无论分档，只返回首选单引擎；
 * - complexityRouting=false → 一律按 medium 宽度取池（不自适应）；
 * - fusion 仅在多引擎且 fusionEnabled 时开启。
 */
export function planSearch(
  config: RouterConfigSnapshot,
  _hints: SearchHints,
  band: ComplexityBand,
): SearchPlan {
  const pool = config.layerPools?.[config.layer] ?? LAYER_ENGINE_POOL[config.layer] ?? []
  const effectiveBand: ComplexityBand = config.complexityRouting ? band : 'medium'
  let width = effectiveBand === 'simple' ? 1 : effectiveBand === 'medium' ? 2 : pool.length
  if (!config.autoFallback) width = 1
  const engineIds = pool.slice(0, Math.max(0, Math.min(width, pool.length)))
  // 垂直加发腿（W9）：命中触发矩阵时追加到计划尾部；autoFallback=false 时
  // 尊重单引擎纪律不加发。
  const verticals =
    config.autoFallback === true &&
    (config.verticalEngineIds?.length ?? 0) > 0 &&
    hintsTargetVerticalX(_hints)
      ? [...(config.verticalEngineIds as readonly string[])]
      : []
  const finalIds = [...engineIds, ...verticals]
  return {
    layer: config.layer,
    engineIds: finalIds,
    fusion: config.fusionEnabled && finalIds.length > 1,
  }
}
