# AUDIT-W10 — 三向对抗审查决策表（安全 / 契约 / UX）

- 审查人：dsh-webstack 红队（W10）；范围：三包源码真对抗审查 + 当场修复。
- 基线：739 测试全绿；验收后：**761 全绿**（webstack 684 / verticals 21 / bridge 56），`pnpm -r run check && pnpm lint` 通过。
- 严重度口径：P0 = 可直接利用/可致瘫；P1 = 防线缺口或泄漏面；P2 = 纵深加固/文档一致性。

## 决策表

| 编号 | 面向 | 严重度 | 描述 | 处置 |
| --- | --- | --- | --- | --- |
| W10-01 | 安全·SSRF | **P0** | `classifyIp` 只识别点分形态的 `::ffff:127.0.0.1`；十六进制缩写 `::ffff:7f00:1`（即 `inet_ntop` 对映射地址的规范输出）与全展开 `0:0:0:0:0:ffff:a00:1` 落入纯 v6 分类被判 **public**，AAAA 记录返回该形态即可绕过 G2 直达回环/内网。 | 已修（src/safety/ssrf.ts）：`classifyV6` 检测 `::ffff:0:0/96` 前缀后剥壳按 v4 规则复判。回归：tests/safety-ssrf.test.ts「W10 回归」5 例。 |
| W10-02 | 安全·SSRF | P1 | NAT64 已知前缀 `64:ff9b::/96` 尾嵌 v4 经网关折返可达内网，原判 public。 | 已修：按 fail-closed 归 reserved。回归同上（2 例断言）。 |
| W10-03 | 安全·SSRF | P1 | 豁免 `host:port` 与 `parsed.port` 严格相等——缺省端口 URL 的 `port===''`，`example.com:443` 对 `https://example.com/` 静默失效（用户以为已豁免，实际 G2 仍拒自托管实例）。 | 已修：按 scheme 等价展开缺省端口（443/80）；显式端口仍精确匹配。回归：豁免边界 5 例（含负例 :443 不放行 http）。 |
| W10-04 | 安全·SSRF | P2 | 方括号 IPv6 字面量豁免 `[fe80::1]:8080` 与 WHATWG hostname `[fe80::1]` 双方带括号无法对齐（且 URL hostname 保留括号）。 | 已修：解析与比较两侧统一剥括号。回归含 DNS 零调用断言。 |
| W10-05 | 安全·凭据泄漏 | P1 | outbound.ts DNS 失败分支消息拼接 `${currentUrl}` 未脱敏（同文件 assertSafeRedirect 用了 redactUrl，纪律不一致）；URL query 携带 api_key 时明文进错误文本。 | 已修：改用 redactUrl。回归：tests/safety-outbound.test.ts 断言 message 不含 TOPSECRET 且含 REDACTED 占位。 |
| W10-06 | 安全·注入 | P2 | 非法 Location 头原样拼进 transport 错误消息——对端可控自由文本，长串/敏感 query 顺流而上。 | 已修：截断 256 字符 + scrubText 后再拼接。回归：4KB 敌意 Location → 无敏感值、message<400 字符。 |
| W10-07 | 安全·ReDoS | **P0** | mcp-generic `MD_LINK_RE` 的 `[^\]]+` 无界贪婪在 `'['×n` 病态行上 O(n²) 回溯：实测 100k 字符 ≈3.25s、200k ≈13s。MCP 工具输出是远端可控输入，同步正则不受阶段护栏超时约束——单腿挂死事件循环。 | 已修：标题段限量 `{1,512}` + 匹配前 `includes('](')` 快速门槛；正常链接语义不变。回归：tests/engines-mcp.test.ts 4 例（200k/80k 敌意行 <1s、常规抽取与去重不变、限量边界回落裸 URL 不丢 url）。 |
| W10-08 | 安全·ReDoS | — | 其余远端输入正则实测安全：DDG anchor/snippet 正则 400k 敌意输入 <1ms；`PINNED_VERSION_RE` 30k `@×n+'!'` 0.1ms；`SEARCH_TOOL_RE` 字面量交替线性；scrub QUERY_PAIR/URL_IN_TEXT 无嵌套量化。 | 不修（附实测数据备查）。 |
| W10-09 | 安全·oEmbed | P2 | verticals `stripHtmlToText` 仅剔标签不剥内容体——`<script>alert(1)</script>` 的 JS 源码以纯文本漏进 snippet；实体混淆形态 `&lt;script&gt;…&lt;/script&gt;` 解码后同样残留。（snippet 为纯文本非渲染宿，故 P2。） | 已修：script/style 整块剥离，且在实体解码前后各扫一遍兜住混淆形态（对齐 extract.stripNoise 纪律）。回归：packages/verticals/tests/verticals-x.test.ts 3 例。 |
| W10-10 | 安全·桥接 | — | bridge key 比较 `timingSafeEq(sha256(key), pairedKeyHash)` 为常时手写实现，比较对象恒为定长 64 hex 摘要（长度早退不泄密）；ticket/key 服务端只存哈希、一次性消费语义正确。 | 不修（核验通过；换 node timingSafeEqual 属风格差异，无行为收益）。 |
| W10-11 | 契约·selectorRules | — | `matchRule` 点边界正确：`evil-example.com` 不匹配 `example.com` 规则（`endsWith('.example.com')` 为假），等长并列取先声明者，FQDN 尾点归一。既有 fetch-selectors 测试已锁。 | 不修（对抗样例复核通过）。 |
| W10-12 | 契约·truncated/URL 首见 | — | fuse 按「原样 URL 串」分组、代表取组内最高分但 `url` 恒为首见原样；fetchPipeline truncated 取各环节析取；history 只记 `{url,title}` 原样字符串；缓存读写均 NormalizedHit 原样。既有 kernel-fusion/fetch-pipeline/history 测试覆盖。 | 不修（不变量守住；本次新增敌意输入下 MCP 文本路径去重回归佐证 W10-07 行为保持例）。 |
| W10-13 | 契约·降级梯 | — | 设置卡三档（settingsScope 可写编辑 / 只读展示 / 不可达默认基线只读卡）由 client-ui.test.tsx（只读降级卡+可编辑卡+invalid 相）与 draft-state 五态矩阵锁死；桥接/垂类缺席不渲染行由 diag-doctor-w9 锁死。 | 不修（可达性测试存在性确认）。 |
| W10-14 | UX·doctor | P2 | 「全冷却」场景只有逐引擎倒计时，无聚合处方——回答了「多久恢复」没回答「该做什么」。 | 已修：全部条目 cooldown 时追加 `webstack.doctor.rx.all-cooldown` 处方行（zh/en 新键 + renderDoctor 派生逻辑）。回归：diag-doctor-w9 2 例（全冷却双语渲染、混合态/空清单不触发）。 |
| W10-15 | UX·doctor | P2 | 「桥未配对」文案只陈述状态无处置动作。 | 已修：zh/en 补「打开扩展弹窗完成配对 + 确认 service worker 存活与总闸开启 + 可忽略」三段式处方。回归：diag-doctor-w9 断言关键词。「垂类关闭」已有设置键指引（`verticals.channels.x`），核验合格不改。 |
| W10-16 | UX·i18n/文档 | P2 | README.zh 配置表缺 schema 键 `verticals.channels.x`、`verticals.selectorRules` 两行；错误码双语处置文案抽查无占位残留（errorText 闭集 union 编译期锁键）。 | 已修：README.zh 补两键行（默认值/生效档/说明与 schema、HOT_RELOADABLE 对齐）。 |

## 附：修复涉及文件

- packages/webstack/src/safety/ssrf.ts、outbound.ts
- packages/webstack/src/engines/mcp-generic.ts
- packages/webstack/src/diag/doctor.ts、src/i18n/doctor.ts
- packages/webstack/README.zh.md
- packages/verticals/src/x-search.ts

新增回归 22 例：safety-ssrf 10、safety-outbound 2、engines-mcp 4、diag-doctor-w9 4、verticals-x 3（合计计入 761 总盘）。
