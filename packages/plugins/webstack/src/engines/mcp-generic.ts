/**
 * MCP 通用搜索引擎适配器（F-108，tier='mcp'）：把任意暴露「搜索类工具」的
 * MCP server 包装为统一引擎面。设计要点：
 *
 * - **懒加载 SDK**：`@modelcontextprotocol/sdk` 是可选 peer——动态 import
 *   （字面量路径，保持可被打包器静态分析），模块缺失时抛
 *   `unrepresentable / mcp sdk not installed`，其余引擎完全不受影响；
 * - **transport 双形态**：stdio → StdioClientTransport（command 解析 + args +
 *   env；win32 下对 npx/npm 等壳脚本解析 `.cmd` 后缀），http →
 *   StreamableHTTPClientTransport(url)；
 * - **工具选择**：entry 显式指定工具名则精确使用（跳过发现阶段）；否则取
 *   listTools 结果中第一个名称或描述匹配 /search|搜索|web/i 的工具；
 * - **结果解析**：callTool 的 structuredContent / JSON 文本走 narrow* 收窄，
 *   纯文本按行启发式抽 URL+标题（markdown 链接优先）；
 * - **取消双保险（W-B-42）**：AbortSignal.any 合并 caller signal 与内部
 *   controller，同时每个 SDK 阶段经 Promise.race 挂截止时间——SDK 不响应
 *   signal 时仍有界返回（超时 transport / 中止 aborted），绝不悬挂。
 *
 * @module webstack/engines/mcp-generic
 */

import { narrowArray, narrowRecord, narrowString, parseJsonLoose } from '../fetch/narrowing.ts'
import { engineError, isEngineError } from '../kernel/errors.ts'
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  McpServerEntry,
  NormalizedHit,
} from '../kernel/types.ts'
import { BaseEngine, freezeDescriptor } from './engine.ts'
import { isoTimestampOrUndefined } from './pool.ts'

// ---------------------------------------------------------------------------
// 契约常量与校验（W-A-02：裸 npx 结构性拒绝）
// ---------------------------------------------------------------------------

/** MCP 引擎单次尝试延迟预算（毫秒）：MCP 冷启动含子进程拉起，预算放宽。 */
export const MCP_LATENCY_BUDGET_MS = 10_000

/**
 * 版本锁定形态：任意启动向量 token 以 `@版本号` 结尾即视为已锁定。
 * `[\w.~-]` 覆盖 semver（1.2.3）、prerelease（1.0.0-beta.1~0）与 dist-tag。
 */
const PINNED_VERSION_RE = /@[\w.~-]+$/

/** 搜索类工具启发式：名称或描述命中任一关键词即可入选。 */
const SEARCH_TOOL_RE = /search|搜索|web/i

/** 校验失败返回的 i18n 键（与 i18n/mcp-infra 分册键集一一对应）。 */
export const MCP_VALIDATION_KEYS = {
  idRequired: 'webstack.mcp.id-required',
  commandRequired: 'webstack.mcp.command-required',
  unpinned: 'webstack.mcp.unpinned',
  urlRequired: 'webstack.mcp.url-required',
  credRefEmpty: 'webstack.mcp.cred-ref-empty',
} as const

/** 运行期错误 detail 位使用的 i18n 键。 */
export const MCP_ERROR_KEYS = {
  sdkMissing: 'webstack.mcp.sdk-missing',
  connectFailed: 'webstack.mcp.connect-failed',
  noSearchTool: 'webstack.mcp.no-search-tool',
  callFailed: 'webstack.mcp.call-failed',
} as const

/**
 * 校验一条 McpServerEntry：合法返回 null，否则返回面向用户的 i18n 键字符串。
 * 规则（id 唯一性由上层注册表负责，这里只查非空）：
 * - stdio：必须提供 command，且启动向量（command+args 任一 token）含
 *   `@version` 锁定形态——裸 npx/uvx 一律拒绝（W-A-02）；
 * - http：必须提供 http(s):// 形态的 url；
 * - credentialRefs（两种 transport 通用）：数组元素必须是非空引用名。
 */
export function validateMcpEntry(entry: McpServerEntry): string | null {
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    return MCP_VALIDATION_KEYS.idRequired
  }
  if (entry.transport === 'stdio') {
    if (typeof entry.command !== 'string' || entry.command.trim() === '') {
      return MCP_VALIDATION_KEYS.commandRequired
    }
    const tokens = [entry.command, ...(entry.args ?? [])]
    const pinned = tokens.some(
      token => typeof token === 'string' && PINNED_VERSION_RE.test(token),
    )
    if (!pinned) return MCP_VALIDATION_KEYS.unpinned
  } else {
    if (typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url)) {
      return MCP_VALIDATION_KEYS.urlRequired
    }
  }
  for (const ref of entry.credentialRefs ?? []) {
    if (typeof ref !== 'string' || ref.trim() === '') return MCP_VALIDATION_KEYS.credRefEmpty
  }
  return null
}

// ---------------------------------------------------------------------------
// SDK 面：本地结构类型（SDK 是可选 peer，不与其深层类型耦合）
// ---------------------------------------------------------------------------

/** MCP 工具描述的最小视图（name 理论上必有，仍按 unknown 宽松收窄）。 */
export interface McpToolInfo {
  readonly name?: unknown
  readonly description?: unknown
}

/** Client 用法的最小结构面（connect/listTools/callTool/close）。 */
export interface McpClientLike {
  connect(transport: unknown): Promise<void>
  listTools(): Promise<unknown>
  callTool(request: { name: string; arguments: Record<string, string> }): Promise<unknown>
  close(): Promise<void>
}

/** 动态 import('@modelcontextprotocol/sdk/client/index.js') 的最小结构视图。 */
interface SdkClientModule {
  readonly Client: new (
    info: { name: string; version: string },
    options?: Record<string, unknown>,
  ) => McpClientLike
}

/** stdio/streamableHttp transport 模块的最小结构视图。 */
interface SdkTransportModule {
  // transport 实例对引擎是不透明值（只交给 client.connect）。
  readonly StdioClientTransport?: new (params: {
    command: string
    args?: readonly string[]
    env?: Readonly<Record<string, string>>
  }) => unknown
  readonly StreamableHTTPClientTransport?: new (url: URL, options?: unknown) => unknown
}

/** 引擎运行所需的成对 SDK 导出。 */
export interface SdkBundle {
  readonly Client: SdkClientModule['Client']
  readonly TransportCtor: new (...args: never[]) => unknown
}

/**
 * win32 壳脚本解析：npx/npm/pnpm 等在 Windows 上是 .cmd 垫片，裸名直接 spawn
 * 会 ENOENT。已知命令补 `.cmd` 后缀，其余按用户原样透传（绝对路径/自定义
 * 可执行文件不做猜测改写）。
 */
export function resolveStdioCommand(command: string): string {
  if (process.platform !== 'win32') return command
  const knownShim = /^(npx|npm|pnpm|yarn|bunx|uvx|uv)$/i.test(command.trim())
  return knownShim ? `${command.trim()}.cmd` : command
}

/** 由 entry 构建冻结描述符：tier='mcp'、kind='search'、零凭据画像。 */
function buildMcpDescriptor(entry: McpServerEntry): EngineDescriptor {
  return freezeDescriptor({
    id: `mcp-${entry.id}`,
    kind: 'search',
    tier: 'mcp',
    caps: {},
    cost: { keysRequired: 0, quotaHint: 'unknown' },
    latencyBudgetMs: MCP_LATENCY_BUDGET_MS,
  })
}

// ---------------------------------------------------------------------------
// 阶段护栏（W-B-42 取消双保险的第二道）
// ---------------------------------------------------------------------------

/** 单阶段保底时长下限：预算耗尽后仍给一次微小的收敛窗口，避免 0ms 抖动。 */
const STAGE_FLOOR_MS = 250

/**
 * 给一个 SDK 阶段挂双保险：caller/内部 signal 任一中止 → `aborted`；
 * 截止时间先到 → `transport/timeout`。无论 SDK 内部是否响应 signal，
 * 本函数都在有限时间内落定（Promise.race 三方竞速）。
 */
async function guardedStage<T>(
  label: string,
  fn: () => Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<T> {
  const remainingMs = Math.max(STAGE_FLOOR_MS, deadlineAt - Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        engineError('transport', `mcp ${label} timed out after ${remainingMs}ms`, {
          detail: 'timeout',
        }),
      )
    }, remainingMs)
  })
  const abortP = new Promise<never>((_, reject) => {
    onAbort = () => reject(engineError('aborted', `mcp ${label} aborted by caller`))
    // 信号可能在本阶段开始前就已中止（事件不会重放）：立即落定，防悬挂。
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([fn(), timeout, abortP])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// 工具选择与结果解析（纯函数，离线可测）
// ---------------------------------------------------------------------------

/**
 * 从 listTools 结果中选择搜索工具：显式指定优先精确采用（不做存在性猜测，
 * 服务端可能不在列表回显）；否则取第一个名称或描述匹配 SEARCH_TOOL_RE 者。
 * 描述命中但工具无名时继续向后扫描；找不到返回 undefined。
 */
export function pickMcpSearchTool(
  tools: readonly McpToolInfo[],
  preferred?: string,
): string | undefined {
  if (preferred !== undefined && preferred !== '') return preferred
  for (const tool of tools) {
    const name = narrowString(tool.name)
    if (name !== undefined && SEARCH_TOOL_RE.test(name)) return name
    const description = narrowString(tool.description)
    if (name !== undefined && description !== undefined && SEARCH_TOOL_RE.test(description)) {
      return name
    }
  }
  return undefined
}

/** JSON 载荷里可能承载结果数组的键（按序探测）。 */
const RESULT_LIST_KEYS = ['results', 'items', 'data', 'organic', 'hits'] as const

/** 把 unknown 载荷规约成候选条目数组：顶层数组直用，否则探测常见包裹键。 */
export function collectResultItems(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  const rec = narrowRecord(value)
  if (rec === undefined) return []
  for (const key of RESULT_LIST_KEYS) {
    const candidate = rec[key]
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

/** 条目字段别名表：url / 标题 / 摘要 / 时间各自按序收窄。 */
const ITEM_URL_KEYS = ['url', 'link', 'href'] as const
const ITEM_TITLE_KEYS = ['title', 'name'] as const
const ITEM_SNIPPET_KEYS = ['snippet', 'description', 'content', 'summary', 'text'] as const
const ITEM_DATE_KEYS = ['publishedAt', 'published_date', 'date', 'time'] as const

/** 在记录上按别名表收窄第一个非空字符串。 */
function firstString(
  item: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = narrowString(item[key])
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * MCP JSON 结果 → NormalizedHit[]（W-B-52 不信任形状）：逐条收窄，缺 url
 * 即跳过；标题缺失回落 url（绝不编造占位文案）；published 仅接受 ISO 形态。
 */
export function parseMcpJsonHits(value: unknown, engineId: string, count: number): NormalizedHit[] {
  const hits: NormalizedHit[] = []
  for (const raw of collectResultItems(value)) {
    if (hits.length >= count) break
    const item = narrowRecord(raw)
    if (item === undefined) continue
    const url = firstString(item, ITEM_URL_KEYS)
    if (url === undefined) continue
    const title = firstString(item, ITEM_TITLE_KEYS) ?? url
    const snippet = firstString(item, ITEM_SNIPPET_KEYS)
    const publishedAt = isoTimestampOrUndefined(firstString(item, ITEM_DATE_KEYS))
    hits.push({
      url,
      title,
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      provenance: { engine: engineId, via: 'mcp-tool' },
    })
  }
  return hits.slice(0, Math.max(0, count))
}

/** 行内裸 URL（排除常见尾随标点与闭合括号；非全局，无 lastIndex 状态）。 */
const BARE_URL_RE = /https?:\/\/[^\s<>"'`)\]]+/
/**
 * markdown 链接 `[title](url)`。W10 审计加固（ReDoS）：
 * - 标题段限量 `{1,512}`——`[^\]]+` 无界贪婪在 `'['×n` 这类病态行上是
 *   O(n²) 回溯（实测 100k 字符 ≈3.2s，MCP 工具输出是远端可控输入，且同步
 *   正则不受阶段护栏超时约束，等于事件循环被单腿挂死）；
 * - 匹配前先做 `includes('](')` 快速门槛，无候选的行零回溯成本。
 * 正常 markdown 链接语义不变：标题超 2048 字符本就不该作标题采用。
 */
const MD_LINK_RE = /\[([^\]]{1,512})\]\((https?:\/\/[^\s)]+)\)/g

/** markdown 链接候选行的快速判定片段（先验门槛，防病态行进入回溯引擎）。 */
const MD_LINK_HINT = ']('

/**
 * MCP 纯文本结果 → NormalizedHit[]（行级启发式）：markdown 链接行优先
 * （锚文本作标题），其次裸 URL 行（URL 之外的残余文本作标题，空则回落
 * url）。同 URL 只保留首见；无任何 URL 的行忽略。
 */
export function parseMcpTextHits(text: string, engineId: string, count: number): NormalizedHit[] {
  const seen = new Set<string>()
  const hits: NormalizedHit[] = []
  const push = (url: string, title: string): void => {
    if (seen.has(url) || hits.length >= count) return
    seen.add(url)
    hits.push({
      url,
      title: title === '' ? url : title,
      provenance: { engine: engineId, via: 'mcp-tool' },
    })
  }
  for (const line of text.split(/\r?\n/)) {
    if (hits.length >= count) break
    let matched = false
    if (line.includes(MD_LINK_HINT)) {
      for (const match of line.matchAll(MD_LINK_RE)) {
        const [, rawTitle, rawUrl] = match
        if (rawUrl === undefined || rawUrl === '') continue
        matched = true
        push(rawUrl, (rawTitle ?? '').trim())
      }
    }
    if (matched) continue
    const bare = BARE_URL_RE.exec(line)?.[0]
    if (bare === undefined || bare === '') continue
    push(
      bare,
      line
        .replace(bare, '')
        .replace(/[-*>\s]+/g, ' ')
        .trim(),
    )
  }
  return hits.slice(0, Math.max(0, count))
}

/** callTool 结果的最小结构视图（content 文本块 + structuredContent）。 */
function extractResultPayload(result: unknown): { structured: unknown; text: string } {
  const rec = narrowRecord(result)
  if (rec === undefined) return { structured: undefined, text: '' }
  const parts: string[] = []
  for (const block of narrowArray(rec.content)) {
    const text = narrowString(narrowRecord(block)?.text)
    if (text !== undefined) parts.push(text)
  }
  return { structured: rec.structuredContent, text: parts.join('\n') }
}

// ---------------------------------------------------------------------------
// 引擎适配器
// ---------------------------------------------------------------------------

/** 构造选项：toolName 显式指定工具名（entry 契约未设工具位时的扩展入口）。 */
export interface McpSearchEngineOptions {
  /** 显式工具名：设置后跳过启发式发现，精确调用该名称。 */
  readonly toolName?: string
  /** 测试接缝：覆盖整体截止时刻偏移（默认用 descriptor.latencyBudgetMs）。 */
  readonly stageTimeoutOverrideMs?: number
}

/** MCP 通用搜索适配器：每次 search 建连→发现→调用→关闭，无跨请求状态。 */
export class McpSearchEngine extends BaseEngine {
  private sdkPromise: Promise<SdkBundle> | undefined

  constructor(
    private readonly entry: McpServerEntry,
    private readonly options: McpSearchEngineOptions = {},
  ) {
    super(buildMcpDescriptor(entry))
  }

  /**
   * 真实动态 import 步骤（字面量路径，保持打包器静态分析）。独立成方法便于
   * 测试注入「模块缺失」场景——SDK 是可选 peer，缺席是常态而非异常。
   */
  protected importSdkModules(): Promise<[unknown, unknown]> {
    const isStdio = this.entry.transport === 'stdio'
    return Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      isStdio
        ? import('@modelcontextprotocol/sdk/client/stdio.js')
        : import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]) as Promise<[unknown, unknown]>
  }

  /**
   * 加载并校验 SDK 成对导出（懒加载 + 成功缓存；失败可重试以支持晚装依赖）。
   * 模块缺失/导出缺失统一映射为 unrepresentable / mcp sdk not installed
   * （non-retryable，重试无意义）。
   */
  protected async loadSdkBundles(): Promise<SdkBundle> {
    let clientMod: Partial<SdkClientModule>
    let transportMod: Partial<SdkTransportModule>
    try {
      const loaded = await this.importSdkModules()
      clientMod = loaded[0] as Partial<SdkClientModule>
      transportMod = loaded[1] as Partial<SdkTransportModule>
    } catch (cause) {
      throw engineError('unrepresentable', 'mcp sdk not installed', {
        engineId: this.descriptor.id,
        detail: MCP_ERROR_KEYS.sdkMissing,
        cause,
      })
    }
    const Client = clientMod.Client
    if (typeof Client !== 'function') {
      throw engineError('unrepresentable', 'mcp sdk not installed', {
        engineId: this.descriptor.id,
        detail: MCP_ERROR_KEYS.sdkMissing,
      })
    }
    const TransportCtor =
      this.entry.transport === 'stdio'
        ? transportMod.StdioClientTransport
        : transportMod.StreamableHTTPClientTransport
    if (typeof TransportCtor !== 'function') {
      throw engineError('unrepresentable', 'mcp sdk not installed', {
        engineId: this.descriptor.id,
        detail: MCP_ERROR_KEYS.sdkMissing,
      })
    }
    return { Client, TransportCtor: TransportCtor as new (...args: never[]) => unknown }
  }

  /** 取 SDK 包（懒加载缓存包装）。测试子类覆写 {@link loadSdkBundles} 注入假体。 */
  protected loadSdk(): Promise<SdkBundle> {
    if (this.sdkPromise === undefined) {
      this.sdkPromise = this.loadSdkBundles().catch((cause: unknown) => {
        this.sdkPromise = undefined
        throw cause
      })
    }
    return this.sdkPromise
  }

  /** 组装 transport 实例（stdio 解析 win32 壳脚本并合并 env；http 直用 URL）。 */
  protected buildTransport(bundle: SdkBundle): unknown {
    if (this.entry.transport === 'stdio') {
      const Ctor = bundle.TransportCtor as unknown as NonNullable<
        SdkTransportModule['StdioClientTransport']
      >
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value
      }
      Object.assign(env, this.entry.env ?? {})
      return new Ctor({
        command: resolveStdioCommand(this.entry.command ?? ''),
        ...(this.entry.args === undefined ? {} : { args: [...this.entry.args] }),
        env,
      })
    }
    const Ctor = bundle.TransportCtor as unknown as NonNullable<
      SdkTransportModule['StreamableHTTPClientTransport']
    >
    return new Ctor(new URL(this.entry.url ?? 'http://localhost'))
  }

  /** 统一搜索面：建连→选工具→调用→解析，全程阶段护栏 + caller 中止透传。 */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const startedAt = Date.now()
      const budgetMs = this.options.stageTimeoutOverrideMs ?? this.descriptor.latencyBudgetMs
      const deadlineAt = startedAt + budgetMs
      const internal = new AbortController()
      const signals: AbortSignal[] = []
      if (req.signal !== undefined) signals.push(req.signal)
      signals.push(internal.signal)
      const composed = AbortSignal.any(signals)

      const stage = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
        guardedStage(label, fn, composed, deadlineAt)

      let client: McpClientLike | undefined
      try {
        const bundle = await this.loadSdk()
        const session: McpClientLike = new bundle.Client({ name: 'webstack', version: '0.1.0' })
        client = session

        // ---- connect -------------------------------------------------------
        let transport: unknown
        try {
          transport = this.buildTransport(bundle)
        } catch (cause) {
          throw engineError('transport', 'mcp transport construction failed', {
            engineId: this.descriptor.id,
            detail: MCP_ERROR_KEYS.connectFailed,
            cause,
          })
        }
        try {
          await stage('connect', () => session.connect(transport))
        } catch (thrown) {
          // 阶段护栏产物（aborted/timeout）原样透传；仅包装 SDK 自身异常。
          if (composed.aborted || isEngineError(thrown)) throw thrown
          throw engineError('transport', `mcp connect failed for ${this.entry.id}`, {
            engineId: this.descriptor.id,
            detail: MCP_ERROR_KEYS.connectFailed,
            cause: thrown,
          })
        }

        // ---- 选工具（显式指定则跳过发现）-----------------------------------
        let toolName = this.options.toolName
        if (toolName === undefined || toolName === '') {
          const listing = await stage('listTools', () => session.listTools())
          const tools = narrowArray(narrowRecord(listing)?.tools).flatMap((raw) => {
            const rec = narrowRecord(raw)
            return rec === undefined ? [] : [{ name: rec.name, description: rec.description }]
          })
          toolName = pickMcpSearchTool(tools)
          if (toolName === undefined) {
            throw engineError('unrepresentable', 'no search-capable tool exposed by mcp server', {
              engineId: this.descriptor.id,
              detail: MCP_ERROR_KEYS.noSearchTool,
            })
          }
        }
        // 收敛成常量：闭包内使用，避免 let 窄化丢失与非空断言。
        const chosenTool: string = toolName

        // ---- 调用（site: 硬约束尽力拼接，服务端不识别也不致命）--------------
        const query =
          req.hints.siteFilter === undefined
            ? req.query
            : `${req.query} site:${req.hints.siteFilter}`
        let result: unknown
        try {
          result = await stage('callTool', () =>
            session.callTool({ name: chosenTool, arguments: { query } }),
          )
        } catch (thrown) {
          // 阶段护栏产物（aborted/timeout）原样透传；仅包装 SDK 自身异常。
          if (composed.aborted || isEngineError(thrown)) throw thrown
          throw engineError('http-upstream', `mcp tool call failed: ${chosenTool}`, {
            engineId: this.descriptor.id,
            detail: MCP_ERROR_KEYS.callFailed,
            cause: thrown,
          })
        }

        const payload = extractResultPayload(result)
        if (narrowRecord(result)?.isError === true) {
          throw engineError('http-upstream', 'mcp tool reported isError', {
            engineId: this.descriptor.id,
            detail: MCP_ERROR_KEYS.callFailed,
          })
        }

        // ---- 解析：structuredContent 优先，其次 JSON 文本，最后纯文本启发式 -
        if (payload.structured !== undefined) {
          return parseMcpJsonHits(payload.structured, this.descriptor.id, req.count)
        }
        const loose = parseJsonLoose(payload.text)
        if (loose.ok) return parseMcpJsonHits(loose.value, this.descriptor.id, req.count)
        return parseMcpTextHits(payload.text, this.descriptor.id, req.count)
      } finally {
        // 有界释放：close 自身也挂护栏，防慢关连接拖垮整场操作。
        const closing = client?.close()
        if (closing !== undefined) {
          await guardedStage(
            'close',
            () => closing,
            composed,
            Math.max(deadlineAt, Date.now() + STAGE_FLOOR_MS),
          ).catch(() => undefined)
        }
        internal.abort() // 通知内部通道（若有残留流）终止。
      }
    })
  }
}
