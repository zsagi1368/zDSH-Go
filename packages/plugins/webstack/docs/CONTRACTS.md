# CONTRACTS — 契约总纲速查

单一事实源：`src/kernel/types.ts`（CONTRACT FREEZE · Wave 1 定稿，非 stub）。
本文件是它的**人读索引**：类型速查表 + 波次所有权矩阵历史 + 协作规则。
与 types.ts 冲突时以代码为准；改 types.ts 必须走协作规则第 1 条。

## 1. 类型速查表

### 层与档位词汇

| 类型/常量 | 形状 | 语义要点 |
| --- | --- | --- |
| `SearchLayer` / `SEARCH_LAYERS` | `'native'\|'free'\|'api'\|'selfhosted'\|'mcp'` | 路由层闭集；`native` = 委托宿主内置，不停用不重写 |
| `EngineTier` | `'native'\|'free'\|'keyed'\|'selfhosted'\|'mcp'` | 计费档位；`free` 结构性禁止要求凭据 |
| `EngineKind` | `'search'\|'fetch'\|'both'` | 引擎能力面 |
| `ComplexityBand` | `'simple'\|'medium'\|'complex'` | 复杂度分档（≤16 无操作符 / ≤48 / 其余） |
| `FetchMode` | `'raw'\|'fit'\|'citations'` | 抓取偏好模式；回退链可降级，实际达成值写回 |
| `SessionOnlineMode` | `'off'\|'on'\|'ask'` | 会话联网三态（Host-owned 状态机） |
| `WEBSTACK_PROVIDER_ID` | `'webstack'` | 注册进 seam 的唯一 provider id |
| `TierMode` | `'takeover'\|'coexist'\|'diagnostic'` | 能力降级梯三档 |

### 意图与结果

| 类型 | 字段 | 不变量 |
| --- | --- | --- |
| `SearchHints` | topic? / freshness? / siteFilter? / locale? / hard[] / soft[] | 确定性提取（同输入同输出）；hard 必须满足，soft 尽力且仅对 caps.news 生效 |
| `NormalizedHit` | url / title / snippet? / publishedAt? / provenance | `url` 恒为「原始首见」字符串，禁止规范化改写；缺失字段保持缺失，不编造占位值 |
| `HitProvenance` | engine / score? / via? / note? | note 是 i18n 键不是自由文本（防注入）；score 为融合归一化分（单引擎直出可省略） |
| `AttemptRecord` | engineId / startedAt / durationMs / outcome | outcome ∈ 'ok' \| 错误码；不含敏感文本 |
| `EngineSearchRequest` | query / hints / count / layer / band / signal? | tier·layer 是操作起点快照的一部分（W-B-74） |
| `ContentBudgets` | canonicalChars / renderedChars / errorChars | 三层独立上限互不挤占；超限必须置 truncated 且不写缓存正文 |
| `FetchRequest` / `FetchResult` | url / mode / budgets / signal → url / statusCode / content / mode / truncated / budgets | 目标站 4xx/5xx 是数据不是异常；content 绝不静默为空（带解释上呈） |

### 错误分类学（W-B-40）

- `ENGINE_ERROR_CODES`（10 码闭集）：`transport` / `http-upstream` / `unrepresentable` /
  `aborted` / `auth` / `quota` / `cooldown` / `ssrf-blocked` / `narrow-failed` / `rate-limited`
- `ERROR_CLASSIFICATION`：每码恰一分类——
  retryable: transport, http-upstream, narrow-failed, rate-limited；
  non-retryable: unrepresentable, auth, quota, cooldown；
  terminal: aborted, ssrf-blocked
- `EngineErrorShape`：name='EngineError' + code + engineId? / httpStatus? / retryAfterMs? / detail?
- 完整性由 tests/kernel-errors.test.ts 表驱动锁死：新增码漏映射直接红。

### 安全词汇（分册 05）

| 类型 | 内容 |
| --- | --- |
| `SafetyGate` / `SAFETY_GATE_ORDER` | `G1-static → G2-dns → G3-redirect → G4-body-bound`（顺序即执行顺序） |
| `SsrfRejectReason` | scheme-disallowed / userinfo-present / nonstandard-port / loopback / private-range / link-local / reserved-range / redirect-cross-origin-auth / redirect-to-blocked / body-over-bound |
| `SafetyVerdict` | `{allowed:true}` 或 `{allowed:false, gate, reasonCode, detail?}`；拒绝由调用方映射为 ssrf-blocked（terminal） |

### 缓存词汇（W-B-30~34）

| 类型 | 要点 |
| --- | --- |
| `CacheDomain` | `'search'\|'fetch'\|'vertical'`；分域 TTL 与联合失效的最小分区 |
| `CacheKeyInput` | layer / engineSet / count / hints / tier / credFingerprint / options? —— 字段清单即键维度清单，从请求签名机械推导；新增影响结果的参数必须同时加字段并补相邻差异测试 |
| `PersistenceAdapter` | L1 占位接口（get/set/delete/clearAll）；clearAll 同时清 L0+L1 全部域 |

### 凭据快照（W-B-54/55/74）

| 类型 | 要点 |
| --- | --- |
| `CREDS_SOURCE_ORDER` / `CredSource` | 固定优先级 `legacy-literal → credential-ref → env` |
| `CredSnapshotEntry` | state(configured\|absent) / source? / maskedHint?(前3+尾4) / opaqueId?(sha256 前 8 位)；明文永不出现 |
| `CredsSnapshot` | resolvedAt + entries；每次操作起点解析一次，轮换下次操作即生效 |

### 能力与 HostSeams 结构镜像（W-B-05）

- `CapabilityBitmap`：webSeam / selectorPatchable / settingsSection / inputSlot / credentialsDomain / storageService / bridgeOnline
- `HostSeams` 及 `Seam*` 系列：把平台 API 重述为本包内独立 interface——本包在 monorepo 外可编译、对宿主零 import 依赖；结构兼容由 tests/kernel-types.test.ts 对 `@deepseek-ai/dsh-web` 真实类型做 toExtend 断言锁死（W-B-07）。运行期一律先探测再使用。

## 2. 波次所有权矩阵（历史存档）

按各模块头注释的设计溯源 id 重建，供考古与回归定位：

| 波次 | 所有权范围 | 关键交付与锚点 id |
| --- | --- | --- |
| Wave 0 · 设计 | 分册 01–06、设计溯源清单 | 81-design-inspiration.md 的 W-B-\*\* / W-A-\*\* 编号体系 |
| Wave 1 · 契约冻结 | `kernel/types.ts`（本文件 §1 全部词汇） | CONTRACT FREEZE；W-B-05 结构镜像、W-B-40 错误闭集、W-B-95 截断权上交 |
| 并行波 A · 安全 | `safety/ssrf.ts`、`safety/outbound.ts`、`safety/scrub.ts`、`safety/injection.ts` | W-B-50 四道闸、W-B-53 i18n 键纪律、W-B-56 scrubber 边界 |
| 并行波 B · 引擎 | `engines/engine.ts`、ddg / bing-lite / searxng / native-delegate | W-B-12 免费池零凭据、W-B-35 首见原样 URL、W-B-52 响应不信任 |
| 集成波 C · 内核装配 | `kernel/aggregator.ts`、`kernel/registry.ts`、`index.ts` | W-B-08 降级梯、W-B-10/11 fallback、W-B-74 操作起点快照、W-B-78 加载标记日志 |
| 收尾波 D · 诊断与提示 | `diag/doctor.ts`、`prompt/sections.ts`、i18n 词表 | W-B-90~92 prompt 节预算、W-B-97 廉价可用性、W-B-113/114 doctor 双通道 |
| 平台校准波 | tests/index-plugin.test.ts、docs/CALIBRATION.md | P1–P7 平台事实实证（真实 WebRuntime 闭环） |

## 3. 协作规则

1. **types.ts 只读消费**：并行工程师只允许消费这里的类型；新增或修改公共类型必须走首席架构师。字段语义一经发布不做破坏性变更，只能加可选字段。
2. **错误码 = 契约**：向 `ENGINE_ERROR_CODES` 新增码须同步补 `ERROR_CLASSIFICATION` 映射并更新表驱动测试，否则 CI 红。
3. **键维度 = 契约**：给 `CacheKeyInput` 加字段必须同时补相邻差异测试（宁可 miss 不可错 hit）。
4. **Seam 镜像同步**：修改任何 `Seam*` interface 形状，须确认 tests/kernel-types.test.ts 的 toExtend 断言仍通过（对宿主真实类型的结构兼容锁定）。
5. **共享签名单向流**：engine.ts / pipeline.ts 中「本地结构类型冻结勿改形状」的注释块，改动等同契约变更，须同步对端模块（narrowing / outbound）的逐字对齐注释。
6. **安全词表闭集**：`SAFETY_GATE_ORDER`、`SsrfRejectReason` 只增不改名；i18n 文案按 reasonCode 派生，禁止自由文本进上下文（W-B-53）。
