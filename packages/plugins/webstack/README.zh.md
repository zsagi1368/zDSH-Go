<div align="center">

# WebStack · 网栈

**面向 DeepSeek Harness 的一体化网络搜索与抓取内核插件**

一个插件，覆盖全部搜索层，默认即硬化。

[![CI](https://github.com/zsagi1368/dsh-webstack/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/dsh-webstack/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zsagi1368/dsh-webstack)](https://github.com/zsagi1368/dsh-webstack/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node%20%3E%3D%2022.19-brightgreen)
![Tests](https://img.shields.io/badge/tests-761%20passing-success)

[English](./README.md) · 简体中文

</div>

---

WebStack 向宿主 `ctx.web` 接缝注册唯一的中性聚合器（同时覆盖 `search` 与 `fetch` 两面），把全部决策收拢在自己体内：层路由（`native` / `free` / `api` / `selfhosted` / `mcp`）、查询复杂度分档、多引擎回退、RRF 融合、缓存、凭据解析与四道闸 SSRF 管线。默认**共存模式**：随包的 cordis 补丁为空，上游选择器分毫不动；切换层只是改一条运行时配置，永远不需要重打补丁。

## 特性总览

**搜索**
- **免 Key 免费池，零配置可用**——DuckDuckGo 与 Bing RSS 轻通道开箱即搜；免费层引擎被结构性地禁止依赖密钥。
- **六家 keyed 引擎**——Tavily · Brave · Exa · Jina · Firecrawl · AnySearch，配备 least-in-flight 多键池：仅在鉴权失败时换键。
- **MCP 引擎**——任意搜索类 MCP server 即可作为引擎接入；预设目录自带版本锁定模板，裸 `npx` 命令被结构性拒绝。
- **原生委托档**——`native` 层转发宿主内置实现，不可用时给出可诊断错误而非假装成功。

**智能路由**
- **确定性意图层**——纯正则提取 `site:` 限域、引号短语、时效词与语言；硬约束下推引擎，软偏好仅作建议。
- **复杂度分档**——查询按规则分为 simple / medium / complex，由档位决定引擎集合与是否融合。
- **可调融合**——RRF 归并叠加时效半衰期、权威域加权与同域多样性折扣；重复 URL 始终保留首见原始字符串。

**韧性**
- **回退 + 引擎冷却**——按错误分类决策（重试一次 / 换候选 / 终止）；限频与配额耗尽触发冷却并尊重服务端 `Retry-After`。融合各腿共享档位级预算 race，取消真实下推。
- **双层缓存**——对一切影响结果的维度做 sha256 语义指纹，内存 LRU + single-flight，可选持久层（宿主存储或 `~/.webstack/cache`），联合失效入口先行设计。
- **会话联网模式**——宿主持有的 off / on / ask 三态开关；`on` 强制绕过缓存读取最新结果。

**安全**
- **SSRF 四道闸**——静态校验 → DNS 解析后按 IP 判段 → 重定向逐跳复验 → 有界响应体。豁免表只能跳过第 2 道，1/3/4 永不跳过。
- **凭据链**——遗留字面值 → 宿主凭据引用 → 环境变量三级解析，每次操作产出仅含掩码与哈希 id 的快照；明文绝不进入日志、缓存或渲染树。
- **能力降级梯**——每个可选宿主接缝先探测再使用；能力缺失一律优雅降级而非抛错。

**体验**
- **Web 界面**——带暂存草稿状态机的设置卡 + 输入区联网模式按钮；宿主无可写界面时自动降级为只读/本地态。密钥永不渲染。
- **模型工具**——`web_backend_status`（无副作用诊断）、`web_batch_search`（保序扇出，≤10 条逐项隔离）、`web_history`（历史回放/清空）。
- **中英双语全覆盖**——诊断、错误处置文案与界面文案均为双语。

## 快速上手

通过 DSH 插件机制安装，可使用 GitHub Release 资产：

```bash
# 从 GitHub Releases 下载 dsh-webstack-<version>.tgz，在 bundle 清单中引用
```

```yaml
# bundle 依赖示例
dependencies:
  - name: dsh-webstack
```

到此即可——`free` 层无需任何密钥与额外服务。继续增强：

```yaml
search:
  layer: api            # 切到 keyed 引擎层
engines:
  tavily:
    key: tvly-...       # 或 credentialRef / 环境变量 WEBSTACK_TAVILY_API_KEY
mcpServers:
  - id: ddg-mcp
    transport: stdio
    command: npx duckduckgo-mcp-server@0.1.2   # 必须锁定版本
```

可选卫星包（同仓库、独立安装）：

| 包 | 增加的能力 |
| --- | --- |
| [`dsh-webstack-bridge`](../bridge/extension/README.md) | JS 重页面浏览器渲染兜底（MV3 扩展 + 配对协议） |
| [`dsh-webstack-verticals`](../verticals) | 实验性免凭据 X/Twitter 检索腿（默认关闭，显式开启） |

## 配置

完整键集见 [`src/settings/schema.ts`](./src/settings/schema.ts)。**热** = 下一次操作即生效；**重启** = 结构性变更，需重载插件。

| 键 | 默认值 | 模式 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `true` | 热 | 总开关；关 = provider 报告不可用 |
| `search.layer` | `free` | 热 | `native` / `free` / `api` / `selfhosted` / `mcp` |
| `search.autoFallback` | `true` | 热 | `false` = 仅用首选引擎 |
| `search.maxResults` | `8` | 热 | 请求级取值优先 |
| `search.fusion.enabled` | `true` | 热 | RRF 融合开关 |
| `search.fusion.timeDecayHalfLifeH` | `24` | 热 | 时效半衰期（小时）；`0` 关闭衰减 |
| `search.fusion.authorityBoost` | `1.0` | 热 | 权威域权重乘子 |
| `search.fusion.diversityDiscount` | `0.85` | 热 | 同域重复折扣 |
| `search.complexityRouting` | `true` | 热 | 关闭 = 固定 medium 档宽度 |
| `fetch.pipeline` | `t1` | 热 | `t1` / `t1+t2` / `t1+t2+t3` |
| `fetch.defaultMode` | `raw` | 热 | 首选抽取模式（回退链可能降级） |
| `fetch.maxContentChars` | `12000` | 热 | 渲染预算；canonical 按 ×4 派生、上限 8 MiB |
| `mode.sessionOnline` | `off` | 热 | `on` 强制绕过缓存读取 |
| `cache.enabled` | `true` | 热 | 搜索结果缓存开关 |
| `cache.ttlSearchMin` / `cache.ttlFetchMin` | `10` / `60` | 热 | 分域 TTL（分钟） |
| `cache.persist` | `memory` | 热 | `durable` 启用持久层 L1 |
| `safety.ssrfExempts` | `[]` | 热 | `host:port` / IPv4 CIDR（仅豁免第 2 道） |
| `engines.<id>.key` / `.credentialRef` | — | **重启** | 各引擎凭据 |
| `mcpServers` | `[]` | **重启** | 校验通过的 MCP 条目注册为引擎 |
| `verticals.packEnabled` + `channels.x` | `false` | 热*/重启 | 垂类总开关 + 渠道开关 |
| `verticals.selectorRules` | `[]` | 热 | 站点定制抽取规则（`hostSuffix` + 选择器子集） |
| `advanced.winProxyFallback` | `false` | 热 | 启动期探测并注入 Windows 系统代理（尽力而为） |

## 一次搜索的流水线

```text
query → extractHints        # site:/引号/时效/语言（确定性提取）
      → estimateBand        # simple | medium | complex
      → planSearch          # 层池 × 档宽 × autoFallback
      → creds               # 三级链，单次操作解析一次
      → cache               # 全维度 sha256 指纹
      → fallback            # 冷却跳过 · 重试一次 · 终止语义
      → fuse                # RRF × 衰减 × 权威域 × 多样性
      → seam                # 截断权交还平台
```

抓取共用同一 hardened 出站通道：预算 → SSRF 四道闸 → 可选站点规则 → 抽取回退链（raw→fit）→「状态码即数据」如实上呈；桥接卫星已配对时可获得一次浏览器渲染救援。

各阶段性能包线见 [`docs/BENCHMARK.md`](./docs/BENCHMARK.md)——本地复现：`pnpm --filter dsh-webstack bench`。

## 开发

```bash
pnpm install
pnpm lint              # biome 全工作区
pnpm -r run check      # 各包 类型检查 + 测试 + 构建
pnpm --filter dsh-webstack bench
```

需要 Node.js ≥ 22.19 与 pnpm ≥ 10。零原生模块。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`CHANGELOG.md`](./CHANGELOG.md) | 发布记录 |
| [`SECURITY.md`](./SECURITY.md) | 安全模型、信任边界、漏洞披露 |
| [`docs/AUDIT-W10.md`](./docs/AUDIT-W10.md) | 对抗审查轮：发现项与处置决策表 |
| [`docs/BENCHMARK.md`](./docs/BENCHMARK.md) | 性能包线对照预算 |
| [`docs/CALIBRATION.md`](./docs/CALIBRATION.md) | 平台版本基线与升级流程 |
| [`docs/GOTCHAS.md`](./docs/GOTCHAS.md) | 工程踩坑实录（写给后续维护者） |
| [`docs/CONTRACTS.md`](./docs/CONTRACTS.md) | 冻结类型契约速查 |

## Roadmap

- 原生层句柄捕获，使 `native` 直连宿主内置实现。
- 宿主 locale 探测（当前 prompt 节固定 zh/en 双语）。
- 抓取域缓存接线。
- selectorRules 的设置面编辑器；更多垂类渠道。
- npm 发布自动化。

## 许可证

[MIT](./LICENSE)
