# Changelog

本项目的所有显著变更记录于此。格式基于 Keep a Changelog；
版本遵循语义化版本（0.x 期 API 不稳定）。

## [0.2.0] - 2026-08-24

全管线贯通版：五层路由（native/free/api/selfhosted/mcp）全部有实体引擎或
可诊断降级，抓取面补齐 T3 桥接兜底与站选定制源，缓存获得 L1 持久层，
工具面扩为三件套；三包（webstack / verticals / bridge）761 测试全绿。
安全项经 W10 三向对抗审计（见 `docs/AUDIT-W10.md`）。

### Added

**P0 — 内核与引擎矩阵**

- **keyed 六家引擎矩阵**：Tavily / Brave / Exa / Jina / Firecrawl / AnySearch
  全量接线进 `api` 层候选池；无键即结构化 `auth` 失败交 fallback 换候选，
  绝不匿名降级；429/401/403 → 统一错误映射（Retry-After 换算退避）。
- **MCP 层接入**：配置的 `mcpServers` 条目逐条过 `validateMcpEntry`
  （裸 npx 结构性拒绝），合法条目注册为通用 MCP 搜索引擎；stdio/http 双
  transport，SDK 为可选 peer、缺席静默降级；附静态预设目录
  （`mcp-presets.ts`，版本锁定样板，UI 层后续消费）。
- **原生委托档**：`native` 层经委托引擎转发宿主内置 provider（句柄捕获为
  平台侧 TODO，缺位时可诊断失败并回落，不假装可用）。
- **垂类卫星腿（实验性）**：`verticals.packEnabled && verticals.channels.x`
  时惰性动态导入 `dsh-webstack-verticals`——免费池 `site:` 双站检索 +
  官方 oEmbed 富化的合规免凭据 X 降级链；卫星缺失静默跳过 + i18n 诊断键。
- **RRF 融合三参消费**：时效半衰期 / 权威域乘子 / 同域多样性折扣进入融合
  排序实际计算；复杂度档整体预算 race（medium 5 s / complex 8 s）+ 真取消
  裁腿（allSettled 语义，慢腿记 aborted，部分结果照常融合）。
- **L1 持久层**：`cache.persist=durable` 时 write-through 到宿主 storage
  seam，回落文件 `~/.webstack/cache`；磁盘故障静默降级为 miss；
  memory ↔ durable 经 `attachCache` 热切换。
- **T3 桥接兜底**：浏览器桥接卫星在线时，静态抓取失败或正文过短（疑似 JS
  空壳）单次 `bridge.render(url, 8s)` 兜底；结果以 `statusCode=0` 与
  `via='bridge'` 标注；`ssrf-blocked`/aborted 绝不绕行。
- **会话联网模式**：Host-owned 三态状态机（off/on/ask）；`on` 时搜索强制
  fresh 跳缓存读（写侧照常），由设置驱动即时生效。
- **Windows 系统代理兜底**：`advanced.winProxyFallback=true` 启动早期探测
  系统代理并注入 `HTTPS_PROXY`/`HTTP_PROXY`（尽力而为层，默认关闭）。
- **站选定制源规则**：`verticals.selectorRules`（`hostSuffix` + CSS 选择器
  子集，只到选择器粒度杜绝任意脚本注入面），抓取入口命中后优先抽取。
- **fetch 回退链完备化**：raw→fit 有内容者胜 + JSON pretty-print 分支 +
  「状态即数据」上呈 + 全空解释文案；三层预算 canonical/rendered/error
  独立互不挤占。

**P1 — 工具、诊断与卫星**

- **`web_batch_search` 工具**：≤10 条批量扇出走同一条聚合管线（凭据/缓存/
  融合/fallback 全一致），保序、逐项结构化隔离、超限显式拒绝。
- **`web_history` 工具 + 历史环形账本**：list/clear 参数化回放最近搜索/
  抓取（容量 200），search/fetch 结果统一记账，绝不成为故障点。
- **doctor W9 升级**：报告覆盖桥接/垂类三态与配置面未接线清单；「全冷却」
  追加聚合处方、「桥未配对」给三段式处置（W10-14/15）。
- **i18n 全量双语**：zh/en 词表覆盖错误处置/doctor/prompt/设置/fetch 安全
  各分册；errorText 闭集 union 编译期锁键。
- **客户端半（`dsh-webstack/client`）**：设置卡（keyed slot
  `settings.plugin.item`，五态草稿状态机 + 点路径排队写入，密钥永不进渲染
  树）+ composer 左端会话联网模式按钮（off→on→ask 循环）。
- **桥接卫星包（`dsh-webstack-bridge`）**：浏览器扩展 + 配对协议（key/ticket
  服务端只存哈希、一次性消费）；安装指引见
  `packages/bridge/extension/README.md`。

**P2 — 工程与文档**

- **性能基准**：`pnpm --filter dsh-webstack bench` 全离线确定性基准
  （假 outbound + 脚本化引擎驱动 aggregator 全管线），结果与预算对照表
  见 `docs/BENCHMARK.md`；bench 目录在 check 链之外。
- **升级冒烟 CI**：`.github/workflows/ci.yml` 新增 `upgrade-smoke` job——
  以 next dist-tag 动态重钉全组织 overrides 映射后跑 typecheck +
  kernel-types 契约断言，红 = 上游漂移警报，不阻塞主矩阵。
- **文档族**：CALIBRATION（含 overrides 覆写映射来龙去脉）/ CONTRACTS /
  GOTCHAS / THREAT-MODEL / BENCHMARK / AUDIT-W10；README 双语对齐本版本。
- **设置 schema 全量冻结**：`DEFAULT_SETTINGS` / `HOT_RELOADABLE` 元数据
  齐备（含 `verticals.*`、`advanced.winProxyFallback`），热/重启语义逐键标注。

### Security

对抗审计轮（AUDIT-W10，三向审查：安全/契约/UX）修复：

- **W10-01（P0）**：SSRF G2 的 IPv4 映射地址只识别点分形态，
  `::ffff:7f00:1` 等十六进制缩写被误判 public 可直达回环——剥壳按 v4 复判。
- **W10-07（P0）**：MCP 引擎 markdown 链接正则无界贪婪 ReDoS（200k 敌意行
  ≈13 s 单腿挂死事件循环）——标题段限量 + 快速门槛，正常语义不变。
- **W10-02（P1）**：NAT64 已知前缀尾嵌 v4 折返内网——按 fail-closed 归
  reserved。
- **W10-03（P1）**：SSRF 豁免 `host:port` 对缺省端口 URL 静默失效——按
  scheme 等价展开缺省端口（443/80）。
- **W10-05（P1）**：DNS 失败分支错误消息拼接未脱敏 URL——改 redactUrl，
  query 携带 api_key 不再明文外漏。
- **W10-04 / W10-06 / W10-09（P2）**：IPv6 字面量豁免括号对齐；非法
  Location 头截断 + scrub 后再拼接；垂类 oEmbed snippet 剥离 script/style
  内容体（含实体混淆形态）。
- W10-08/10/11/12/13 经对抗样例复核判定无需修改，实测数据留档于
  `docs/AUDIT-W10.md`。

### Known Limitations

- **native delegate 句柄捕获未接**（平台侧 TODO）：`native` 层已注册委托
  引擎，宿主内置 provider 句柄缺位时可诊断失败并回落，不能真实转发。
- **宿主 locale 探测缺**：守则/状态节固定中文，未按宿主 locale 切换。
- **垂类开启需重载**：`verticals.packEnabled` 关闭即时生效，开启涉及结构
  注册，需重载插件（设置面板已标注 热*）。
- **npm 发布待 token**：发布链路就绪（files/publint/cordis.patch.yml）但
  尚无自动化 token，发版仍为手工步骤。
- fetch 域缓存仍未接线（聚合器当前只读写 search 域；`cache.ttlFetchMin`
  已定义待消费）。
- IPv6 无 CIDR 豁免形态；DNS 核验与实际连接间存在理论 TOCTOU 竞态窗口。
- `selectorPatchable` 无运行期回读验证（接管档自动降级共存）。

## [0.1.0] - 2026-08-24

初始发布。

### Added

- **内核**：中性聚合器（`WebstackAggregator`）双面注册进宿主 `ctx.web`
  seam（search + fetch）；默认共存档（cordis patch 为空表，不改写上游
  选择器）；能力降级梯 takeover → coexist → diagnostic。
- **搜索管线**：确定性 hints 意图提取（site:/引号短语/时效词/语言）→
  复杂度三档分路由 → 计划引擎集与注册表求交 → 凭据三级链解析 → 缓存指纹
  查询 → singleFlight 包裹 fallback 执行 → RRF 轻量融合 → 截断 → seam 映射。
- **引擎池**：免费池开箱即搜——DuckDuckGo HTML 端点适配器 + Bing RSS lite
  通道；自托管 SearXNG JSON 通道（显式配置 baseUrl 后注册）。api/mcp 层
  池位已冻结、引擎未接入。
- **fallback 与冷却**：错误三分类决策（retryable 同候选退避重试一次 /
  non-retryable 换候选 / terminal 整场终止）；rate-limited / quota 引擎级
  冷却（尊重 retryAfterMs，默认 60s / 300s），冷却期内剔除候选并记 warning。
- **缓存**：L0 进程内 Map-LRU（512 条目，分域 TTL search 10min / fetch
  60min / vertical 30min）；键为 `CacheKeyInput` 全维度 sha256 指纹（含凭据
  指纹）；singleFlight 并发去重；`PersistenceAdapter` L1 接口占位（未接线）。
- **安全**：SSRF 四道闸（G1 静态 → G2 DNS 解析 IP 分类 → G3 重定向逐跳
  复验 → G4 有界响应体）；豁免仅跳 G2；统一出站客户端为唯一下网络通道；
  输出边界 scrubber；上游响应窄化 + 截断转义 + 双语非指令横幅。
- **凭据**：三级链 legacy-literal → credentialRef → env；占位符拦截告警；
  快照仅含掩码 hint 与 opaqueId，明文不出闭包。
- **诊断**：`web_backend_status` 工具 + 对话请求双入口 doctor（零副作用，
  双语渲染，按档位处方）；动态 prompt 状态节；加载标记日志。
- **prompt 守则节**：≤200 词双语行为守则常驻 systemPrompt seam。
- **设置**：`installSettingsSection` 安装组合入口子集 schema，热生效；
  全量 `DEFAULT_SETTINGS` / `HOT_RELOADABLE` 元数据冻结于 settings/schema.ts。
