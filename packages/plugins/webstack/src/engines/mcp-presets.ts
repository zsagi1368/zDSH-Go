/**
 * MCP 服务器预设目录（W-B-72 样板数据）：UI/设置层后续消费的**纯静态样板**，
 * 不含任何运行时行为。用户条目只存差异，未覆盖字段回落预设模板。
 *
 * 版本锁定纪律（W-A-02）：所有 npx 命令一律带 `@具体版本号`——版本号为
 * 2026-08-24 经 `npm view <pkg> version` 实查的最新发布版，写死于此以
 * 结构性保证目录中不出现裸 npx（tests/engines-mcp.test.ts 逐条过
 * validateMcpEntry 锁死）。升级 = 显式改这里的版本号，不做自动跟随。
 *
 * @module webstack/engines/mcp-presets
 */

import type { McpServerEntry } from '../kernel/types.ts'

/** 单条预设：id + 展示名 + 可直接实例化为 McpServerEntry 的启动模板。 */
export interface McpPreset {
  /** 预设稳定 id（与用户条目 id 同命名空间，唯一）。 */
  readonly id: string
  /** UI 展示名（原样字符串；本地化由设置层负责）。 */
  readonly label: string
  /**
   * 启动模板。`envRefs` 是 credentialRefs 的样板位：值是凭据引用名约定
   * （经 credentials 域每操作解析，绝不存明文密钥，W-B-55）。
   */
  readonly template: {
    readonly command: string
    readonly args: readonly string[]
    readonly envRefs?: readonly string[]
  }
}

/**
 * 预设目录（顺序即 UI 呈现顺序）。
 * 版本实查记录（2026-08-24，npm view）：
 * duckduckgo-mcp-server@0.1.2 / tavily-mcp@0.2.22 / brave-search-mcp@2.1.0 /
 * exa-mcp-server@3.4.1 / searxng-mcp@1.1.0 —— 五条全部查到，无省略项。
 */
export const MCP_PRESETS: readonly McpPreset[] = Object.freeze([
  {
    id: 'duckduckgo-mcp-server',
    label: 'DuckDuckGo（MCP · 免费无密钥）',
    template: {
      command: 'npx',
      args: ['-y', 'duckduckgo-mcp-server@0.1.2'],
    },
  },
  {
    id: 'tavily-mcp',
    label: 'Tavily（MCP · 需 TAVILY_API_KEY）',
    template: {
      command: 'npx',
      args: ['-y', 'tavily-mcp@0.2.22'],
      envRefs: ['TAVILY_API_KEY'],
    },
  },
  {
    id: 'brave-search-mcp',
    label: 'Brave Search（MCP · 需 BRAVE_API_KEY）',
    template: {
      command: 'npx',
      args: ['-y', 'brave-search-mcp@2.1.0'],
      envRefs: ['BRAVE_API_KEY'],
    },
  },
  {
    id: 'exa-mcp-server',
    label: 'Exa（MCP · 需 EXA_API_KEY）',
    template: {
      command: 'npx',
      args: ['-y', 'exa-mcp-server@3.4.1'],
      envRefs: ['EXA_API_KEY'],
    },
  },
  {
    id: 'searxng-mcp',
    label: 'SearXNG（MCP · 自托管实例）',
    template: {
      command: 'npx',
      args: ['-y', 'searxng-mcp@1.1.0'],
    },
  },
])

/** 把一条预设实例化为可校验的 McpServerEntry（stdio 形态）。 */
export function presetToEntry(preset: McpPreset): McpServerEntry {
  return {
    id: preset.id,
    transport: 'stdio',
    command: preset.template.command,
    args: [...preset.template.args],
    ...(preset.template.envRefs === undefined
      ? {}
      : { credentialRefs: [...preset.template.envRefs] }),
  }
}
