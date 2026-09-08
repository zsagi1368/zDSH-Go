/**
 * MCP 引擎与基础设施模块的用户可见文案（W-B-79 双语全覆盖）：
 * 覆盖 MCP 条目校验、SDK 缺席、连接/工具发现失败、缓存持久层降级与
 * Windows 系统代理探测。键集以 `webstack.mcp.*` / `webstack.cache.*` /
 * `webstack.proxy.*` 为前缀；zh/en 键集奇偶一致性由
 * tests/engines-mcp.test.ts 断言锁死。文案只进 i18n 键，不拼自由文本
 * （W-B-53 防注入）。
 *
 * 说明：本册为独立分册（同 cache-creds 册形态），自带查找函数；并入
 * i18n/index 统一表属于后续波次的接线工作（本波次禁改既有源码语义）。
 *
 * @module webstack/i18n/mcp-infra
 */

/** 本册全部文案键的闭集 union。 */
export type McpInfraI18nKey =
  | 'webstack.mcp.unpinned'
  | 'webstack.mcp.id-required'
  | 'webstack.mcp.command-required'
  | 'webstack.mcp.url-required'
  | 'webstack.mcp.cred-ref-empty'
  | 'webstack.mcp.sdk-missing'
  | 'webstack.mcp.connect-failed'
  | 'webstack.mcp.no-search-tool'
  | 'webstack.mcp.call-failed'
  | 'webstack.cache.adapter-degraded'
  | 'webstack.proxy.detected'
  | 'webstack.proxy.none'

/** 中文处置文案：「发生了什么 + 用户能做什么」。 */
export const mcpInfraMessagesZh: Readonly<Record<McpInfraI18nKey, string>> = Object.freeze({
  'webstack.mcp.unpinned':
    '该 MCP 服务器命令缺少 @version 版本锁定（裸 npx/uvx 已被拒绝）。请把包名写成「包名@具体版本号」形式，避免上游发版悄悄改变行为。',
  'webstack.mcp.id-required': 'MCP 服务器条目缺少 id。请为本条目填写一个非空且唯一的标识符。',
  'webstack.mcp.command-required':
    'stdio 型 MCP 条目必须提供启动命令 command。请在条目中补充可执行命令及其启动参数。',
  'webstack.mcp.url-required':
    'http 型 MCP 条目必须提供 http(s):// 形式的服务地址 url。请检查该条目的 URL 配置。',
  'webstack.mcp.cred-ref-empty':
    'credentialRefs 列表中存在空引用名。请删除空项或补齐有效的凭据引用名。',
  'webstack.mcp.sdk-missing':
    '未安装 @modelcontextprotocol/sdk，MCP 引擎不可用。安装该依赖后重载插件即可启用 MCP 层；其余引擎不受影响。',
  'webstack.mcp.connect-failed':
    '无法连接到 MCP 服务器。请确认命令/地址正确、服务器进程可启动，以及网络可达后重试。',
  'webstack.mcp.no-search-tool':
    '该 MCP 服务器没有暴露任何搜索类工具（名称或描述需含 search/web/搜索）。请改用支持搜索工具的服务器，或在条目中显式指定工具名。',
  'webstack.mcp.call-failed':
    'MCP 搜索工具调用失败。请检查服务端日志与参数格式；若持续失败可暂时停用该条目。',
  'webstack.cache.adapter-degraded':
    '缓存持久层读写失败，已静默降级为内存缓存（本次不落盘）。功能不受影响，仅重启后不保留。',
  'webstack.proxy.detected':
    '已检测到 Windows 系统代理设置，出站请求将尽力经其转发。若代理需要认证，请在系统中配置后重试。',
  'webstack.proxy.none': '未检测到 Windows 系统代理，出站请求直连目标站点。',
})

/** English resolution copy. */
export const mcpInfraMessagesEn: Readonly<Record<McpInfraI18nKey, string>> = Object.freeze({
  'webstack.mcp.unpinned':
    'The MCP server command is missing an @version pin (bare npx/uvx rejected). Write the package as "package@exact-version" so upstream releases can\'t silently change behavior.',
  'webstack.mcp.id-required':
    'The MCP server entry is missing an id. Provide a non-empty, unique identifier for this entry.',
  'webstack.mcp.command-required':
    'A stdio MCP entry must provide a launch command. Add the executable command and its arguments to the entry.',
  'webstack.mcp.url-required':
    'An http MCP entry must provide a service URL of the form http(s)://. Check the URL configured on this entry.',
  'webstack.mcp.cred-ref-empty':
    'The credentialRefs list contains an empty reference name. Remove the empty item or supply a valid credential reference.',
  'webstack.mcp.sdk-missing':
    '@modelcontextprotocol/sdk is not installed, so MCP engines are unavailable. Install it and reload the plugin to enable the MCP layer; other engines are unaffected.',
  'webstack.mcp.connect-failed':
    'Could not connect to the MCP server. Verify the command/URL, that the server process can start, and network reachability, then retry.',
  'webstack.mcp.no-search-tool':
    'This MCP server exposes no search-capable tool (name or description must contain search/web/搜索). Use a server with a search tool, or specify the tool name explicitly on the entry.',
  'webstack.mcp.call-failed':
    'The MCP search tool call failed. Check the server logs and argument shape; disable the entry temporarily if it keeps failing.',
  'webstack.cache.adapter-degraded':
    'The cache persistence layer failed to read/write and has silently degraded to memory-only caching (nothing written this round). Functionality is unaffected; entries are just not kept across restarts.',
  'webstack.proxy.detected':
    'A Windows system proxy was detected; outbound requests will best-effort route through it. If the proxy requires authentication, configure it in system settings first.',
  'webstack.proxy.none': 'No Windows system proxy detected; outbound requests go direct.',
})

/** 取本册文案；未知 locale 安全回落中文（与其余分册同约定）。 */
export function mcpInfraText(key: McpInfraI18nKey, locale: 'zh' | 'en' = 'zh'): string {
  return locale === 'en' ? mcpInfraMessagesEn[key] : mcpInfraMessagesZh[key]
}
