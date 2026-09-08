/**
 * 设置 schema 单一事实源（W-B-75 / F-115）：`webstack.*` 命名空间全部键的
 * schema 与热生效元数据都从这里生成；设置卡与守则文本均由其派生
 * （boost A-08 反制）。MVP 设置面走 installSettingsSection（校准定案：
 * 平台 API 存在），缺失时降级为命令行配置档。
 *
 * HOT_RELOADABLE 语义：true = 改值即对下一次操作生效（操作起点快照，
 * W-B-74）；false = 涉及结构重建（engines/mcpServers 的增删），需重载插件。
 *
 * @module webstack/settings/schema
 */

import type { FetchMode, SearchLayer, SelectorRule, SessionOnlineMode } from '../kernel/types.ts'

/** 单引擎设置节点（`engines.<id>`）。缺字段 = 用全局默认。 */
export interface EngineNodeSettings {
  /** 引擎总开关（缺省 true，随注册表默认）。 */
  enabled?: boolean
  /**
   * 遗留字面值密钥（三级解析链第 1 级；占位符保存时阻断）。
   * `key` 是规范键位；`apiKey` 为历史别名，读取侧 `key ?? apiKey` 兼容。
   */
  key?: string
  /** 历史别名字面值密钥（与 `key` 同层；新配置一律写 `key`）。 */
  apiKey?: string
  /** 宿主 credentials 域引用名（三级解析链第 2 级）。 */
  credentialRef?: string
}

/**
 * 默认配置快照（与分册 04 §1 schema 总表一致的全键集）。
 * 数值语义：fusion 三参为融合排序权重；cache.ttl*Min 与缓存分域 TTL 表
 * 对齐（search 10min / fetch 60min）。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  search: {
    layer: 'free' satisfies SearchLayer,
    autoFallback: true,
    maxResults: 8,
    fusion: {
      enabled: true,
      /** 时效半衰期（小时）：越旧命中衰减越多。 */
      timeDecayHalfLifeH: 24,
      /** 权威域加成系数。 */
      authorityBoost: 1.0,
      /** 同域重复结果折价系数。 */
      diversityDiscount: 0.85,
    },
    /** 查询复杂度分档路由（W-B-14）开关。 */
    complexityRouting: true,
  },
  fetch: {
    pipeline: 't1',
    defaultMode: 'raw' satisfies FetchMode,
    maxContentChars: 12_000,
  },
  mode: {
    sessionOnline: 'off' satisfies SessionOnlineMode,
  },
  cache: {
    enabled: true,
    ttlSearchMin: 10,
    ttlFetchMin: 60,
    persist: 'memory',
  },
  safety: {
    ssrfExempts: [] as string[],
  },
  /** 引擎级覆盖表：键 = engineId；增删需重载插件（见 HOT_RELOADABLE）。 */
  engines: {} as Record<string, EngineNodeSettings>,
  /** 启用的 MCP server 名单；增删需重载插件。 */
  mcpServers: [] as string[],
  verticals: {
    /** 垂直卫星包总闸（实验性）：默认关闭，须用户显式开启。 */
    packEnabled: false,
    /** 逐频道开关：全部默认关闭，且受 packEnabled 总闸约束。 */
    channels: {
      x: false,
    },
    /** 站选定制源规则（F-203）：抓取入口 host 最长后缀命中后优先选择器抽取。 */
    selectorRules: [] as SelectorRule[],
  },
  advanced: {
    /** hints 提取词表语言：'auto' 跟随查询语言，或固定 'zh'/'en'。 */
    hintsLocale: 'auto',
    /**
     * Windows 系统代理兜底（默认 false）：开启后 activate 早期探测一次
     * 系统代理并注入 HTTPS_PROXY/HTTP_PROXY（尽力而为层，见 safety/winproxy）。
     */
    winProxyFallback: false,
  },
})

/** 设置键路径 → 是否热生效。engines/mcpServers 增删=false，其余全 true。 */
export const HOT_RELOADABLE: Readonly<Record<string, boolean>> = Object.freeze({
  enabled: true,
  'search.layer': true,
  'search.autoFallback': true,
  'search.maxResults': true,
  'search.fusion.enabled': true,
  'search.fusion.timeDecayHalfLifeH': true,
  'search.fusion.authorityBoost': true,
  'search.fusion.diversityDiscount': true,
  'search.complexityRouting': true,
  'fetch.pipeline': true,
  'fetch.defaultMode': true,
  'fetch.maxContentChars': true,
  'mode.sessionOnline': true,
  'cache.enabled': true,
  'cache.ttlSearchMin': true,
  'cache.ttlFetchMin': true,
  'cache.persist': true,
  'safety.ssrfExempts': true,
  engines: false,
  mcpServers: false,
  'verticals.packEnabled': true,
  'verticals.channels.x': true,
  'verticals.selectorRules': true,
  'advanced.hintsLocale': true,
  'advanced.winProxyFallback': true,
})
