/**
 * 多引擎结果融合（P1 / F-104）：RRF k=60 基础分 + 可选时效半衰期衰减 +
 * 权威域乘子 + 同 host 多样性折扣 + 原样 URL 串去重（来源引擎并入 via）。
 *
 * 融合管线（固定顺序，纯函数、无状态——同一输入永远得到同一输出）：
 * 1. 逐引擎集合内取排名 → RRF 贡献 Σ 1/(k+rank)（多引擎共识自然累加）；
 * 2. 每条出现独立施加时效衰减与权威域乘子（occurrence-level：publishedAt
 *    与 host 都是单条属性）；无发布时间/时间在未来/参数非法 = 不衰减；
 * 3. 按「原样 URL 串」精确去重：组分 = 各出现得分累加（RRF 共识语义）；
 *    代表命中取组内单条综合得分最高者（title/snippet/publishedAt/provenance
 *    随代表），`url` 字段恒为首见原样字符串（W-B-35：身份归一只发生在
 *    比较内部，不改写表示）；组内全部来源引擎按首见序去重并入 `via`
 *    （如 `'ddg+bing-lite'`；单来源保留代表原有 via）；
 * 4. 多样性折扣：按组分降序行走，同 host 第 2 条起乘 discount^(序位-1)；
 * 5. 归一化（组最高分=1）写 `provenance.score`，降序输出（并列保首见序）。
 *
 * @module webstack/kernel/fusion
 */

import type { FusionParams, NormalizedHit } from './types.ts'

/** RRF 常数 k：排名倒数加权的平滑项（融合固定值）。 */
export const RRF_K = 60

/**
 * 内置权威域常量表（host 后缀语义）：`.` 开头条目按顶级后缀匹配
 * （`foo.gov` 命中 `.gov`），其余按域名后缀匹配（`www.nature.com` 命中
 * `nature.com`）。大小写不敏感；结尾点号归一后比较。
 */
export const AUTHORITY_DOMAINS: readonly string[] = Object.freeze([
  'wikipedia.org',
  'arxiv.org',
  'github.com',
  '.gov',
  '.edu',
  'nature.com',
  'science.org',
])

/** 与 settings schema `search.fusion.*` 默认值一一对应的融合参数缺省值。 */
export const DEFAULT_FUSION_PARAMS: FusionParams = Object.freeze({
  enabled: true,
  timeDecayHalfLifeH: 24,
  authorityBoost: 1,
  diversityDiscount: 0.85,
})

/**
 * 判定 host 是否命中内置权威域表。解析失败/空串一律 false——
 * 判定器自身绝不允许成为故障点。
 */
export function isAuthoritativeHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/\.+$/, '')
  if (host === '') return false
  return AUTHORITY_DOMAINS.some((entry) => {
    if (entry.startsWith('.')) return host.endsWith(entry)
    return host === entry || host.endsWith(`.${entry}`)
  })
}

/** URL → host 小写化（结尾点号剥除）；不可解析返回空串。 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return ''
  }
}

/**
 * 时效衰减因子：0.5^(ageHours/halfLife)；无 publishedAt / 非法时间 /
 * 时间在未来 / halfLife 非 (>0 且有限) 一律返回 1（不衰减）。
 */
function decayFactor(publishedAt: string | undefined, halfLifeH: number, now: number): number {
  if (!(halfLifeH > 0) || !Number.isFinite(halfLifeH)) return 1
  if (publishedAt === undefined || publishedAt === '') return 1
  const atMs = Date.parse(publishedAt)
  if (!Number.isFinite(atMs)) return 1
  const ageHours = (now - atMs) / 3_600_000
  if (!(ageHours > 0)) return 1
  return 0.5 ** (ageHours / halfLifeH)
}

/** 权威域乘子：host 命中表且 boost 有效（>0 有限且 ≠1 才实际生效）。 */
function authorityMultiplier(url: string, boost: number): number {
  if (!(boost > 0) || !Number.isFinite(boost)) return 1
  return isAuthoritativeHost(hostOf(url)) ? boost : 1
}

/** URL 去重组（键 = 原样 URL 串）。 */
interface Group {
  firstUrl: string
  /** 组内单条综合得分最高的代表命中。 */
  best: NormalizedHit
  /** 代表的单条综合得分（代表竞争用）。 */
  bestScore: number
  /** 组分 = 各出现综合得分累加（RRF 共识）。 */
  score: number
  /** 全局首见序（稳定并列裁决）。 */
  order: number
  /** 来源引擎（首见序去重）。 */
  engines: string[]
}

/**
 * 多引擎结果融合（模块头注释载完整管线）。`now` 为时效衰减的参考时刻
 * （epoch 毫秒），缺省当前时间；测试注入固定时钟以获得确定性断言。
 *
 * 输出每条命中的 `provenance.score` 为归一化分（最高分组 = 1，6 位小数）；
 * 输入集合不被修改。
 */
export function fuse(
  resultSets: readonly NormalizedHit[][],
  params: FusionParams,
  now: number = Date.now(),
): NormalizedHit[] {
  const groups = new Map<string, Group>()

  // ---- 1~3：逐集合排名 → RRF × 衰减 × 权威 → 原样 URL 串分组 --------------
  let globalOrder = 0
  for (const set of resultSets) {
    const perSetRank = new Map<string, number>()
    for (const hit of set) {
      const engineId = hit.provenance.engine
      const rank = (perSetRank.get(engineId) ?? 0) + 1
      perSetRank.set(engineId, rank)
      const contribution = 1 / (RRF_K + rank)
      const occurrence =
        contribution *
        decayFactor(hit.publishedAt, params.timeDecayHalfLifeH, now) *
        authorityMultiplier(hit.url, params.authorityBoost)

      const existing = groups.get(hit.url)
      if (existing === undefined) {
        groups.set(hit.url, {
          firstUrl: hit.url,
          best: hit,
          bestScore: occurrence,
          score: occurrence,
          order: globalOrder,
          engines: [engineId],
        })
      } else {
        existing.score += occurrence
        if (occurrence > existing.bestScore) {
          existing.best = hit
          existing.bestScore = occurrence
        }
        if (!existing.engines.includes(engineId)) existing.engines.push(engineId)
      }
      globalOrder++
    }
  }

  // ---- 4：组分降序行走 + 同 host 多样性折扣 -------------------------------
  const ordered = [...groups.values()].toSorted((a, b) => b.score - a.score || a.order - b.order)
  const perHostOrdinal = new Map<string, number>()
  const discount =
    params.diversityDiscount > 0 && params.diversityDiscount < 1 ? params.diversityDiscount : 1
  const scored = ordered.map((group, position) => {
    const host = hostOf(group.firstUrl)
    // 序位在「折扣前」降序行走中计数（MMR 式贪心）：同 host 首条保满分。
    const ordinal = (perHostOrdinal.get(host) ?? 0) + 1
    perHostOrdinal.set(host, ordinal)
    return { group, final: group.score * discount ** (ordinal - 1), position }
  })

  // ---- 5：按折扣后终分降序输出，归一化写 provenance.score ------------------
  const ranked = scored.toSorted((a, b) => b.final - a.final || a.position - b.position)
  const maxScore = ranked[0]?.final ?? 0
  return ranked.map(({ group, final }) => {
    const normalized = maxScore > 0 ? final / maxScore : final
    const base = group.best
    const mergedVia = group.engines.length > 1 ? group.engines.join('+') : base.provenance.via
    return {
      ...base,
      url: group.firstUrl,
      provenance: {
        ...base.provenance,
        ...(mergedVia === undefined ? {} : { via: mergedVia }),
        score: Number(normalized.toFixed(6)),
      },
    }
  })
}
