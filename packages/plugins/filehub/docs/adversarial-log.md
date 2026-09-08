# FileHub 对抗验证日志（M6 三轮红队，2026-08-24）

> 三轮 = 路径与文件系统 / 网络面 /
> 逻辑与资源。每条成功攻击都有具名修复 + `tests/adversarial/` 归置的回归测试；
> 失败攻击同样记录于此并固化为防退化断言。"结果=已防御"表示攻击在修复前即被
> 既有防线挡下（本轮补固化测试）；"结果=攻破→已修复"表示本轮发现真实缺口。

## 第一轮 · 路径与文件系统

| 攻击 | 预期 | 结果 |
|---|---|---|
| upload relpath 单编码穿越 `../../escape.txt` | 400 拒绝，不落盘 | 已防御（sanitizeRelativePath 拒 `..` 段）；回归：`tests/adversarial/paths.test.ts › rejects single-encoded ../ with 400` |
| upload relpath 双编码 `%252e%252e%252f…` | 不产生目录穿越 | 已防御（safeDecode 仅解码一次 → 字面量百分号文本成为无害扁平文件名）；回归：同文件 `neutralizes double-encoded …` |
| UNC 路径 `\\server\share\x.txt` | 400 拒绝 | 已防御（反斜杠归一后判绝对形式）；回归：`rejects UNC paths and drive-letter forms` |
| 盘符变体 `C:\` / `c:/` / `Z:relative.txt` | 400 拒绝 | 已防御（大小写盘符正则）；回归同上 |
| NTFS ADS `notes.txt:secret` | 冒号不得落盘 | 已防御（sanitizeFileName 将 `:` 替换为 `_`）；回归：`defuses NTFS alternate data stream separators` |
| 尾点尾空格 `evil.txt . . ` / 保留名 CON/con.txt | 规范化 + 前缀化解 | 已防御；回归：`normalizes trailing dots/spaces` |
| 正反斜杠混排 `docs/..\..\b.txt` | 400 拒绝 | 已防御（先归一后分段再拒 `..`）；回归：`rejects mixed-separator traversal` |
| 超长路径（绝对 >260 字符，插件上限内） | 接受或干净拒绝，绝不逃逸 | 已防御（32 段/512 字符双限 + 落点包含断言）；回归：`accepts a >260-char destination strictly inside the sandbox` 与纯函数用例 |
| DELETE `?path=` 爬升 `<root>\..\..\victim` | 403 且受害者完好 | 已防御（isStrictlyInside）；回归：`refuses ..-climbing absolute paths` |
| DELETE 兄弟前缀 `<root>-evil\f.txt` | 403 | 已防御（R3 缺陷反转延续）；回归：`refuses sibling-prefix confusion` |
| **DELETE 穿越预埋目录 junction**（`<root>\link\outside.txt`，link→外部目录） | 403 且外部文件完好 | **攻破→已修复**：词法包含看不见 junction；lifecycle.deleteFile 增加 realpath 双边复检（`src/server/lifecycle.ts`）。回归：`refuses deletion THROUGH a planted directory junction` |
| **upload 经预埋 junction 子目录写文件**（relpath `leak/leaked.txt`） | 拒绝且外部零写入 | **攻破→已修复**：atomicDedupeWrite 在 mkdir 后对 root/directory 做 realpath 包含复检（`src/server/upload.ts`），违者 400。回归：`answers 400 and writes NOTHING outside the workspace` |
| **read_document 经指向外部的符号链接文件读密文** | 拒绝读取 | **攻破→已修复**：tools.readWorkspaceFile 增加 realpath 包含断言（`src/server/tools.ts`）。回归：`refuses to read a FILE SYMLINK whose target lives outside the workspace` |
| sessionId 变体（`..%2F..%2Fetc`、`a%2Fb`、`%2e%2e`、`sess..1!`、`.`）打 session DELETE/list/upload | 全部 4xx，不触盘 | 已防御（白名单正则 + WHATWG 点段归一落入 404 兜底）；回归：`rejects path-ish session ids (…) on every endpoint` |
| 竞态三角：并发 upload×12 + delete×6 + sweep×2 同会话 | 无未处理异常，状态码合法，终态一致 | 已防御（信号量/原子写/幂等删除协同）；回归：`survives interleaved upload/delete/sweep with a consistent end state` |

## 第二轮 · 网络面

| 攻击 | 预期 | 结果 |
|---|---|---|
| IPv6 zone id `[fe80::1%25eth0]` / `[::1%25eth0]:11434` | 拒绝且不外拨 | 已防御（Node URL 直接拒绝该字面量 → UrlPolicyError fail closed）；回归：`network.test.ts › rejects IPv6 zone-id spellings` |
| 超大/八进制/十六进制/十进制 IP 串（2130706433、0177.0.0.1、0x7f…、127.1、99999999999999999999） | 归一后判定环回/私网并拒绝 | 已防御（inet_aton 式归一 + 数值越界 fail closed）；回归：`normalizes oversized / octal / hex / decimal IP spellings before judging` |
| URL userinfo 骗局 `http://safe.com@127.0.0.1` | 以 host 为权威拒绝 | 已防御（WHATWG hostname 忽略 userinfo）；回归：`defeats the userinfo trick` |
| DNS 重绑定 mock（首答公网、次答私网） | 任一答案非公网即整体拒绝 | 已防御（lookup all + 逐答案复检）；回归：`fails closed when DNS resolves ANY private answer` |
| 解析失败（NXDOMAIN mock） | fail closed 不盲拨 | 已防御；回归同上 |
| **讲解端点 302 重定向到内网/元数据地址** | 不跟随重定向 | **攻破→已修复**：fetch 默认跟随重定向，urlPolicy 只审配置 URL，存在一跳绕过。修复：vision 两级通道全部显式 `redirect:'error'`（`src/server/vision.ts`），新增 fetchImpl 测试缝。回归：`never follows redirects: every outbound call passes redirect:"error"` + 行为用例 `a 3xx answer degrades to no-caption` |
| Origin 伪造矩阵补遗（`null`、空串、垃圾串、跨域主机、`localhost.example`、IPv6 括号错配） | 除同源外一律拒绝；缺失放行非浏览器客户端 | 已防御（hostname 比较 + fail closed）；回归：`pure fence: Origin null / junk / cross-origin all fail` |
| remoteAddress 十六进制映射形 `::ffff:7f00:1` | 不被误判环回 | 已防御（fail closed 方向——仅识别点分映射形）；回归：`remoteAddress loopback check sees through ::ffff: mapping only` |
| 伪造 Origin + 仿冒非环回 remoteAddress 直传 | 403 | 已防御（Origin+remoteAddress 双条件 FR-F7）；回归：`forged Origin from a spoofed non-loopback remote is rejected with 403` |
| upload 头注入：`x-file-relpath` 夹带 `\r\nX-Injected: 1` | 不得走私第二个请求 | 已防御（传输层/解析器拒绝 CR/LF 头值）；回归：`CR/LF in x-file-relpath cannot smuggle a second request` |
| upload 超长头（64KB 文件名） | 4xx 或连接拒绝，绝不持久化 | 已防御（16KB 头行上限）；回归：`oversized header values are refused … never persisted` |
| upload 非 UTF8 字节序列头（`%FF%FE%80bad`） | 400 fail closed | 已防御（decodeURIComponent 异常路径）；回归：`non-UTF8 byte sequences in file headers fail closed with 400` |

## 第三轮 · 逻辑与资源

| 攻击 | 预期 | 结果 |
|---|---|---|
| search/library `q` 参数 ReDoS（8KB 级病理查询 ×4 形态：长串、重叠子序列、正则味垃圾、点星尾巴） | 有界时间内 200 返回（评分无正则回溯） | 已防御（includes/startsWith/贪心双指针，全线性）；回归计时绊线：`answers a pathological query in bounded time`、`library q filter resists …` |
| 索引器 symlink 环 + maxFiles 双重压测（互指 junction + 强制 TTL=0 连续重建 ×5） | 终止、truncated=true、不爆栈；宽上限下环后代至多进入一次 | 已防御（祖先 canonical 集 + maxFiles 硬停）；回归：`terminates a mutual junction cycle under maxFiles … within budget` |
| LRU 解析缓存投毒（同 sha256 内容、不同 format/sheet 键互相污染） | 键隔离，互不干扰 | 已防御（键含 format+规范 options）；回归：`same content parsed as two formats yields two INDEPENDENT cache entries`、sheet 选择器隔离用例 |
| KV 元数据与磁盘不一致（绕过 FileHub 手删物理文件后 list/library 出幽灵条目） | 不出幽灵或自愈 | **攻破→已修复**：library.entriesFor 此前纯信 meta，磁盘缺失仍展示幽灵行。修复：逐行 stat 校验，ENOENT 即剔除该行并跳过展示，同一请求完成自愈（`src/server/library.ts`）。回归：`library drops the entry AND prunes its metadata row once the file vanished`、list 侧一致性用例 |
| i18n 插值注入：文件名含 HTML/script 片段经 React 渲染；全仓 raw-HTML sink 扫描 | JSX 默认转义成立；dangerouslySetInnerHTML/innerHTML/document.write 零存在 | 已防御；回归：`xss.test.tsx › contains ZERO dangerouslySetInnerHTML / innerHTML usages under src/`、dock 敌意名渲染两用例 |

## 战果汇总

- 成功攻击 5 起，全部当轮修复并固化回归：junction 写入逃逸（upload）、junction 删除
  逃逸（DELETE）、symlink 越权读（read_document）、caption 重定向一跳 SSRF、KV 幽灵条目。
- 失败攻击 27 起，逐条固化为防退化断言。
- 回归归置：`tests/adversarial/{paths,network,logic,xss}.test.ts` +
  `tests/performance/budget.test.ts`；功能链路另见 `tests/server/caption-passthrough.test.ts`。
