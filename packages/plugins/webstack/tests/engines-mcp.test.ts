/**
 * MCP 引擎与预设目录（全离线）：validateMcpEntry 表驱动校验、预设目录
 * 结构性锁定保证、SDK 假体注入的引擎行为面（工具选择/解析/取消双保险）、
 * 纯函数解析器与 i18n 分册奇偶一致性。
 */
import { describe, expect, it } from 'vitest'
import {
  MCP_ERROR_KEYS,
  MCP_LATENCY_BUDGET_MS,
  MCP_VALIDATION_KEYS,
  type McpClientLike,
  McpSearchEngine,
  parseMcpJsonHits,
  parseMcpTextHits,
  pickMcpSearchTool,
  resolveStdioCommand,
  type SdkBundle,
  validateMcpEntry,
} from '../src/engines/mcp-generic.ts'
import { MCP_PRESETS, presetToEntry } from '../src/engines/mcp-presets.ts'
import {
  type McpInfraI18nKey,
  mcpInfraMessagesEn,
  mcpInfraMessagesZh,
} from '../src/i18n/mcp-infra.ts'
import type { EngineSearchRequest, McpServerEntry, NormalizedHit } from '../src/kernel/types.ts'

// ---------------------------------------------------------------------------
// 公共脚手架：假 SDK / 假 client / 请求工厂
// ---------------------------------------------------------------------------

const REQ = (over: Partial<EngineSearchRequest> = {}): EngineSearchRequest => ({
  query: 'webstack test',
  hints: { hard: [], soft: [] },
  count: 5,
  layer: 'mcp',
  band: 'simple',
  ...over,
})

/** callTool 默认返回：content 文本块承载 JSON 载荷（常见 server 形态）。 */
function jsonTextResult(payload: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/** 假 server 行为规格。 */
interface FakeSpec {
  tools?: readonly { name: string; description?: string }[]
  connectError?: Error
  listToolsResult?: unknown
  callToolImpl?: (name: string, args: Record<string, string>) => Promise<unknown> | unknown
}

class FakeClient implements McpClientLike {
  readonly toolCalls: { name: string; arguments: Record<string, string> }[] = []
  listToolCount = 0
  closed = false

  constructor(private readonly spec: FakeSpec) {}

  async connect(): Promise<void> {
    if (this.spec.connectError !== undefined) throw this.spec.connectError
  }

  async listTools(): Promise<unknown> {
    this.listToolCount++
    return this.spec.listToolsResult ?? { tools: this.spec.tools ?? [] }
  }

  async callTool(request: { name: string; arguments: Record<string, string> }): Promise<unknown> {
    this.toolCalls.push(request)
    return await Promise.resolve(
      this.spec.callToolImpl !== undefined
        ? this.spec.callToolImpl(request.name, request.arguments)
        : jsonTextResult({ results: [] }),
    )
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

/**
 * 把假 client 包成 SdkBundle。用 Proxy construct 陷阱让 `new Client(...)`
 * 直接得到共享的 FakeClient 实例（记录器状态同源）。刻意不用
 * 「构造器 return 对象」写法：biome 会把 function 包装自动改写成箭头
 * （useArrowFunction，箭头不可 new）、把类构造器 return 判为
 * noConstructorReturn——Proxy 形态语义等价且免疫两种改写。
 */
function bundleFor(client: FakeClient): SdkBundle {
  // oxlint-disable-next-line typescript/no-extraneous-class -- empty named class is the Proxy target for `new Client(...)`.
  const ClientCtor = new Proxy(class StubClient {}, {
    construct: () => client,
  }) as unknown as new (
    info: { name: string; version: string },
    options?: Record<string, unknown>,
  ) => McpClientLike
  return {
    Client: ClientCtor,
    // oxlint-disable-next-line typescript/no-extraneous-class -- SDK type requires a constructor value; tests never transport.
    TransportCtor: class DummyTransport {} as never,
  }
}

/** 注入假 SDK 的测试引擎。 */
class HarnessEngine extends McpSearchEngine {
  private readonly clients: FakeClient[] = []

  constructor(entry: McpServerEntry, spec: FakeSpec = {}, options = {}) {
    const client = new FakeClient(spec)
    super(entry, options)
    this.clients.push(client)
  }

  /** 最近一次创建的假 client（每个引擎实例只建一次连接）。 */
  get lastClient(): FakeClient {
    return this.clients[0] as FakeClient
  }

  protected override async loadSdkBundles(): Promise<SdkBundle> {
    return bundleFor(this.lastClient)
  }
}

/** 模拟 SDK 未安装的测试引擎（在 import 接缝抛错）。 */
class MissingSdkEngine extends McpSearchEngine {
  protected override importSdkModules(): Promise<[unknown, unknown]> {
    throw new Error("Cannot find package '@modelcontextprotocol/sdk'")
  }
}

const STDIO_PINNED: McpServerEntry = {
  id: 'srv',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'duckduckgo-mcp-server@0.1.2'],
}

// ---------------------------------------------------------------------------
// validateMcpEntry 表驱动
// ---------------------------------------------------------------------------

describe('validateMcpEntry · 表驱动', () => {
  const cases: readonly {
    name: string
    entry: McpServerEntry
    expected: string | null
  }[] = [
    {
      name: 'stdio npx 带版本 → 通过',
      entry: { id: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'pkg@1.2.3'] },
      expected: null,
    },
    {
      name: '裸 npx（args 无 @version）→ unpinned',
      entry: { id: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
      expected: MCP_VALIDATION_KEYS.unpinned,
    },
    {
      name: 'command 本体带 @latest 形态也算锁定',
      entry: { id: 'a', transport: 'stdio', command: 'pkg@0.1.0' },
      expected: null,
    },
    {
      name: 'scoped 包带版本 → 通过',
      entry: {
        id: 'a',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@scope/pkg@1.0.0-beta.1'],
      },
      expected: null,
    },
    {
      name: 'uvx 裸包 → unpinned',
      entry: { id: 'a', transport: 'stdio', command: 'uvx', args: ['tool'] },
      expected: MCP_VALIDATION_KEYS.unpinned,
    },
    {
      name: '缺 command → command-required',
      entry: { id: 'a', transport: 'stdio' },
      expected: MCP_VALIDATION_KEYS.commandRequired,
    },
    {
      name: '空 command → command-required',
      entry: { id: 'a', transport: 'stdio', command: '   ' },
      expected: MCP_VALIDATION_KEYS.commandRequired,
    },
    {
      name: '空 id → id-required',
      entry: { id: '', transport: 'stdio', command: 'npx', args: ['-y', 'p@1.0.0'] },
      expected: MCP_VALIDATION_KEYS.idRequired,
    },
    {
      name: 'http 缺 url → url-required',
      entry: { id: 'a', transport: 'http' },
      expected: MCP_VALIDATION_KEYS.urlRequired,
    },
    {
      name: 'http 非 http(s) 协议 → url-required',
      entry: { id: 'a', transport: 'http', url: 'ftp://example.com/mcp' },
      expected: MCP_VALIDATION_KEYS.urlRequired,
    },
    {
      name: 'http https url → 通过',
      entry: { id: 'a', transport: 'http', url: 'https://example.com/mcp' },
      expected: null,
    },
    {
      name: 'credentialRefs 含空串 → cred-ref-empty',
      entry: {
        id: 'a',
        transport: 'http',
        url: 'https://example.com',
        credentialRefs: ['good', ''],
      },
      expected: MCP_VALIDATION_KEYS.credRefEmpty,
    },
    {
      name: 'credentialRefs 全非空 → 通过',
      entry: {
        id: 'a',
        transport: 'http',
        url: 'http://localhost:8080/mcp',
        credentialRefs: ['EXA_API_KEY'],
      },
      expected: null,
    },
  ]

  for (const tc of cases) {
    it(`validateMcpEntry：${tc.name}`, () => {
      expect(validateMcpEntry(tc.entry)).toBe(tc.expected)
    })
  }
})

// ---------------------------------------------------------------------------
// 预设目录：结构性保证不出现裸 npx（W-B-72 样板数据）
// ---------------------------------------------------------------------------

describe('MCP_PRESETS · 结构性锁定', () => {
  it('至少包含 5 条预设且 id 唯一', () => {
    expect(MCP_PRESETS.length).toBeGreaterThanOrEqual(5)
    expect(new Set(MCP_PRESETS.map(preset => preset.id)).size).toBe(MCP_PRESETS.length)
  })

  it('五家已知服务全部在列（ddg/tavily/brave/exa/searxng）', () => {
    for (const id of [
      'duckduckgo-mcp-server',
      'tavily-mcp',
      'brave-search-mcp',
      'exa-mcp-server',
      'searxng-mcp',
    ]) {
      expect(MCP_PRESETS.some(preset => preset.id === id)).toBe(true)
    }
  })

  it('每条模板的启动向量都带 @version 锁定 token（正则直查）', () => {
    for (const preset of MCP_PRESETS) {
      const tokens = [preset.template.command, ...preset.template.args]
      expect(tokens.some(token => /@[\w.~-]+$/.test(token))).toBe(true)
    }
  })

  it('每条预设实例化后通过 validateMcpEntry（结构性保证无裸 npx）', () => {
    for (const preset of MCP_PRESETS) {
      expect(validateMcpEntry(presetToEntry(preset))).toBeNull()
    }
  })

  it('envRefs 样板位映射为 credentialRefs 且深拷贝（模板不被实例共享可变数组污染）', () => {
    const tavily = MCP_PRESETS.find(preset => preset.id === 'tavily-mcp')
    expect(tavily).toBeDefined()
    const entry = presetToEntry(tavily!)
    expect(entry.credentialRefs).toEqual(['TAVILY_API_KEY'])
    expect(entry.args).not.toBe(tavily!.template.args)
    expect(entry.credentialRefs).not.toBe(tavily!.template.envRefs)
    expect(entry.args).toEqual(tavily!.template.args)
  })
})

// ---------------------------------------------------------------------------
// 引擎行为面（假 SDK 注入）
// ---------------------------------------------------------------------------

describe('McpSearchEngine · 描述符', () => {
  it('tier=mcp、kind=search、latencyBudgetMs=10000 且运行期冻结', () => {
    const engine = new HarnessEngine(STDIO_PINNED)
    expect(engine.descriptor.tier).toBe('mcp')
    expect(engine.descriptor.kind).toBe('search')
    expect(engine.descriptor.latencyBudgetMs).toBe(MCP_LATENCY_BUDGET_MS)
    expect(engine.descriptor.latencyBudgetMs).toBe(10_000)
    expect(engine.descriptor.cost.keysRequired).toBe(0)
    expect(Object.isFrozen(engine.descriptor)).toBe(true)
    expect(Object.isFrozen(engine.descriptor.caps)).toBe(true)
  })

  it('descriptor.id 由 entry.id 派生（mcp- 前缀防跨层冲突）', () => {
    expect(new HarnessEngine(STDIO_PINNED).descriptor.id).toBe('mcp-srv')
  })
})

describe('McpSearchEngine · 工具选择与调用', () => {
  it('名称匹配 /search/i 的第一个工具被选中并携带 query 调用', async () => {
    const engine = new HarnessEngine(STDIO_PINNED, {
      tools: [
        { name: 'ping' },
        { name: 'web_search', description: 'full web search' },
        { name: 'other_search_tool' },
      ],
    })
    const res = await engine.search(REQ())
    expect(res.attempts[0]?.outcome).toBe('ok')
    expect(engine.lastClient.toolCalls[0]?.name).toBe('web_search')
    expect(engine.lastClient.toolCalls[0]?.arguments.query).toBe('webstack test')
    // provenance 盖章为本描述符 id（W-B-16）
    expect(engine.lastClient.listToolCount).toBe(1)
  })

  it('描述含「搜索」的工具同样入选（双语启发式）', async () => {
    const engine = new HarnessEngine(STDIO_PINNED, {
      tools: [{ name: 'fetcher', description: '网页搜索聚合工具' }],
    })
    const res = await engine.search(REQ())
    expect(res.hits.length).toBe(0) // 默认载荷 results=[]
    expect(engine.lastClient.toolCalls[0]?.name).toBe('fetcher')
  })

  it('显式 toolName 精确使用并跳过发现阶段（listTools 不被调用）', async () => {
    const engine = new HarnessEngine(STDIO_PINNED, {}, { toolName: 'custom_lookup' })
    await engine.search(REQ())
    expect(engine.lastClient.listToolCount).toBe(0)
    expect(engine.lastClient.toolCalls[0]?.name).toBe('custom_lookup')
  })

  it('hints.siteFilter 以 site: 片段拼接进 query（尽力而为）', async () => {
    const engine = new HarnessEngine(STDIO_PINNED, {}, { toolName: 's' })
    await engine.search(REQ({ hints: { hard: [], soft: [], siteFilter: 'example.com' } }))
    expect(engine.lastClient.toolCalls[0]?.arguments.query).toContain('site:example.com')
  })

  it('无任何搜索类工具 → unrepresentable + no-search-tool 键', async () => {
    const engine = new HarnessEngine(STDIO_PINNED, { tools: [{ name: 'echo' }, { name: 'calc' }] })
    await expect(engine.search(REQ())).rejects.toMatchObject({
      name: 'EngineError',
      code: 'unrepresentable',
      detail: MCP_ERROR_KEYS.noSearchTool,
    })
  })

  it('connect 抛错 → transport + connect-failed 键，attempt 记录错误码', async () => {
    const engine = new HarnessEngine(STDIO_PINNED, { connectError: new Error('spawn ENOENT') })
    await expect(engine.search(REQ())).rejects.toMatchObject({
      name: 'EngineError',
      code: 'transport',
      detail: MCP_ERROR_KEYS.connectFailed,
    })
    expect(engine.lastAttempt?.outcome).toBe('transport')
  })

  it('服务端 isError=true → http-upstream + call-failed 键', async () => {
    const engine = new HarnessEngine(STDIO_PINNED, {
      tools: [{ name: 'web_search' }],
      callToolImpl: () => ({ content: [], isError: true }),
    })
    await expect(engine.search(REQ())).rejects.toMatchObject({
      code: 'http-upstream',
      detail: MCP_ERROR_KEYS.callFailed,
    })
  })

  it('SDK 缺失（import 失败）→ unrepresentable / mcp sdk not installed', async () => {
    const engine = new MissingSdkEngine(STDIO_PINNED)
    await expect(engine.search(REQ())).rejects.toMatchObject({
      name: 'EngineError',
      code: 'unrepresentable',
      message: 'mcp sdk not installed',
      detail: MCP_ERROR_KEYS.sdkMissing,
    })
    // 失败不缓存：晚装依赖后同实例可重试成功路径（loadSdk 缓存语义）。
    await expect(engine.search(REQ())).rejects.toMatchObject({ code: 'unrepresentable' })
  })
})

describe('McpSearchEngine · 结果解析', () => {
  it('JSON 文本载荷走 narrow* 收窄：url/title/snippet/publishedAt', async () => {
    const engine = new HarnessEngine(STDIO_PINNED, {
      tools: [{ name: 'web_search' }],
      callToolImpl: () =>
        jsonTextResult({
          results: [
            {
              url: 'https://example.com/a?b=1&c=2',
              title: 'Example A',
              snippet: 'first',
              publishedAt: '2026-08-01T00:00:00Z',
            },
            { link: 'https://example.com/b', name: 'Example B' },
            { title: 'no url here' },
            'garbage-string',
          ],
        }),
    })
    const res = await engine.search(REQ({ count: 10 }))
    expect(res.hits.length).toBe(2)
    expect(res.hits[0]).toMatchObject({ url: 'https://example.com/a?b=1&c=2', title: 'Example A' })
    expect(res.hits[0]?.publishedAt).toBe('2026-08-01T00:00:00Z')
    expect(res.hits[1]).toMatchObject({ url: 'https://example.com/b', title: 'Example B' })
    expect(res.hits.every(hit => hit.provenance.engine === 'mcp-srv')).toBe(true)
  })

  it('structuredContent 优先于 content 文本', async () => {
    const engine = new HarnessEngine(STDIO_PINNED, {
      tools: [{ name: 'web_search' }],
      callToolImpl: () => ({
        content: [{ type: 'text', text: '{"results":[]}' }],
        structuredContent: { items: [{ url: 'https://structured.example/x', title: 'S' }] },
      }),
    })
    const res = await engine.search(REQ())
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0]?.url).toBe('https://structured.example/x')
  })

  it('纯文本载荷按行启发式：markdown 链接优先，裸 URL 取残余文本作标题', async () => {
    const text = [
      '- [Alpha](https://one.example/a) extra note',
      'plain https://two.example/b?q=1 trailing.',
      'no url line should be ignored',
    ].join('\n')
    const engine = new HarnessEngine(STDIO_PINNED, {
      tools: [{ name: 'web_search' }],
      callToolImpl: () => ({ content: [{ type: 'text', text }] }),
    })
    const res = await engine.search(REQ({ count: 3 }))
    expect(res.hits).toHaveLength(2)
    expect(res.hits[0]).toMatchObject({ url: 'https://one.example/a', title: 'Alpha' })
    expect(res.hits[1]?.url).toBe('https://two.example/b?q=1')
    expect(res.hits[1]?.title).not.toContain('https://two.example/b')
  })
})

describe('McpSearchEngine · 取消双保险（W-B-42）', () => {
  it('caller 中止：callTool 悬挂也立即以 aborted 结算', async () => {
    const controller = new AbortController()
    const engine = new HarnessEngine(STDIO_PINNED, {
      tools: [{ name: 'web_search' }],
      callToolImpl: () => new Promise<void>(() => undefined), // 永不落定
    })
    const pending = engine.search(REQ({ signal: controller.signal }))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'EngineError', code: 'aborted' })
  })

  it('SDK 不响应 signal 时阶段护栏兜底：有界返回 transport/timeout', async () => {
    const engine = new HarnessEngine(
      STDIO_PINNED,
      { tools: [{ name: 'web_search' }], callToolImpl: () => new Promise<void>(() => undefined) },
      { stageTimeoutOverrideMs: 30 }, // 实际受 STAGE_FLOOR_MS 下限约束（250ms）
    )
    await expect(engine.search(REQ())).rejects.toMatchObject({
      code: 'transport',
      detail: 'timeout',
    })
    expect(engine.lastAttempt?.outcome).toBe('transport')
  }, 5000)
})

// ---------------------------------------------------------------------------
// 纯函数解析器补充
// ---------------------------------------------------------------------------

describe('pickMcpSearchTool / resolveStdioCommand / 解析器', () => {
  it('pickMcpSearchTool：preferred 直通；名称优先；描述命中取其工具名', () => {
    expect(pickMcpSearchTool([{ name: 'a' }, { name: 'b' }], 'zzz')).toBe('zzz')
    expect(pickMcpSearchTool([{ name: 'desc-match', description: 'web index' }])).toBe(
      'desc-match',
    )
    expect(pickMcpSearchTool([{ name: 'ping' }, { name: 'web_search' }])).toBe('web_search')
  })

  it('pickMcpSearchTool：无名但描述命中的条目被跳过，继续向后扫描', () => {
    const picked = pickMcpSearchTool([
      { description: '搜索聚合（无名残缺条目）' },
      { name: 'fallback_web' },
    ])
    expect(picked).toBe('fallback_web')
    expect(pickMcpSearchTool([])).toBeUndefined()
    expect(
      pickMcpSearchTool([{ description: 'no keywords here' }, { name: 'calc' }]),
    ).toBeUndefined()
  })

  it('resolveStdioCommand：win32 对已知壳脚本补 .cmd；其余原样', () => {
    const isWin = process.platform === 'win32'
    expect(resolveStdioCommand('npx')).toBe(isWin ? 'npx.cmd' : 'npx')
    expect(resolveStdioCommand('C:\\tools\\myserver.exe')).toBe('C:\\tools\\myserver.exe')
  })

  it('parseMcpJsonHits：count 截断与顶层非数组包裹键探测', () => {
    const payload = {
      data: [{ url: 'https://a.example/1', title: '1' }, { url: 'https://a.example/2' }],
    }
    expect(parseMcpJsonHits(payload, 'e', 1)).toHaveLength(1)
    expect(parseMcpJsonHits(payload, 'e', 9)).toHaveLength(2)
    expect(parseMcpJsonHits({ unrelated: true }, 'e', 5)).toHaveLength(0)
    expect(parseMcpJsonHits(null, 'e', 5)).toHaveLength(0)
  })

  it('parseMcpTextHits：同 URL 去重保首见；无 URL 文本得空数组', () => {
    const hits: NormalizedHit[] = parseMcpTextHits(
      'https://dup.example/x first\nagain https://dup.example/x\nnothing here',
      'e',
      10,
    )
    expect(hits).toHaveLength(1)
    expect(parseMcpTextHits('completely plain', 'e', 10)).toHaveLength(0)
  })

  // ---- W10 审计回归：markdown 链接正则的 ReDoS 加固 ------------------------
  it('W10 ReDoS：超长 [ 字符行（无 ]( 候选）零回溯快速返回空', () => {
    const evil = '['.repeat(200_000)
    const started = Date.now()
    expect(parseMcpTextHits(evil, 'e', 10)).toHaveLength(0)
    expect(Date.now() - started).toBeLessThan(1000) // 修复前同输入 ≈13s（O(n²) 回溯）
  })

  it('W10 ReDoS：含 ]( 的病态行仍受标题限量约束，毫秒级返回', () => {
    const evil = `${'['.repeat(80_000)}](`
    const started = Date.now()
    expect(parseMcpTextHits(evil, 'e', 10)).toHaveLength(0)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('W10 行为保持：常规 markdown 链接抽取与去重语义不变', () => {
    const nl = String.fromCharCode(10)
    const hits: NormalizedHit[] = parseMcpTextHits(
      [
        '[Alpha 结果](https://alpha.example/a)',
        '[Beta](https://beta.example/b)',
        '[Alpha 二见](https://alpha.example/a)',
      ].join(nl),
      'e',
      10,
    )
    expect(hits).toHaveLength(2)
    expect(hits[0]?.url).toBe('https://alpha.example/a')
    expect(hits[0]?.title).toBe('Alpha 结果')
    expect(hits[1]?.title).toBe('Beta')
  })

  it('W10 边界：标题恰在限量内照常采用；超限量标题回落裸 URL 提取（URL 不丢）', () => {
    const okTitle = 't'.repeat(512)
    const within = parseMcpTextHits(`[${okTitle}](https://within.example/w)`, 'e', 10)
    expect(within).toHaveLength(1)
    expect(within[0]?.title).toBe(okTitle)

    const overTitle = 't'.repeat(600)
    const over = parseMcpTextHits(`[${overTitle}](https://over.example/o)`, 'e', 10)
    expect(over).toHaveLength(1)
    expect(over[0]?.url).toBe('https://over.example/o')
  })
})

// ---------------------------------------------------------------------------
// i18n 分册（W-B-79 双语奇偶一致）
// ---------------------------------------------------------------------------

describe('i18n · mcp-infra 分册', () => {
  it('键数 ≥8 且 zh/en 键集完全一致', () => {
    const zhKeys = Object.keys(mcpInfraMessagesZh).sort()
    const enKeys = Object.keys(mcpInfraMessagesEn).sort()
    expect(zhKeys.length).toBeGreaterThanOrEqual(8)
    expect(zhKeys).toEqual(enKeys)
  })

  it('任务要求的关键键全部存在且双语非空', () => {
    const required: McpInfraI18nKey[] = [
      'webstack.mcp.unpinned',
      'webstack.mcp.no-search-tool',
      'webstack.mcp.connect-failed',
      'webstack.mcp.sdk-missing',
      'webstack.cache.adapter-degraded',
      'webstack.proxy.detected',
      'webstack.proxy.none',
    ]
    for (const key of required) {
      expect(mcpInfraMessagesZh[key].length).toBeGreaterThan(0)
      expect(mcpInfraMessagesEn[key].length).toBeGreaterThan(0)
    }
  })

  it('校验键常量与分册表对齐（防拼写漂移）', () => {
    for (const value of Object.values(MCP_VALIDATION_KEYS)) {
      expect(value in mcpInfraMessagesZh).toBe(true)
    }
    for (const value of Object.values(MCP_ERROR_KEYS)) {
      expect(value in mcpInfraMessagesZh).toBe(true)
    }
  })
})
