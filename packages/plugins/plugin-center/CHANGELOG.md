# Changelog — zdsh-plugin-center

All notable changes are documented here. Format follows Keep a Changelog;
versioning is semver. 中文说明见同文件下半部分。

## [0.2.0] - 2026-08-24

Operations surface, adversarial hardening, first-party registry.

### Added

- **Guardian wiring**: `guardian/toggle` + `guardian/status` routes drive the
  detached watchdog with launch command and web port from config.
- **Backup manager**: list snapshots and restore byte-verified copies through
  a two-phase confirm (one-shot id/code pair, typo-tolerant until success).
- **Uninstall surface** in the client through the same one-shot dialog.
- **Signed remote catalogs**: remote snapshots require a matching
  `catalog.json.sha256`; the local cache is digest-checked too. First-party
  registry lives at `zsagi1368/zdsh-plugin-registry`.
- **Closed-loop integration test**: real node:http server + real child-process
  CLI stand-in over real temp profile files (market → stage → apply → audit →
  uninstall → restore → replay refusal).

### Hardened (three adversarial review rounds, re-verified to zero P0/P1)

- Command argv allowlist + catalog charset pinning close shell injection
  through catalog-controlled owner/repo/version.
- SSRF guard judges full inet_aton numeric forms (`2130706433`, `127.1`,
  hex, octal), IPv4-compatible ::/96 and NAT64 embeds (RFC 6052 + RFC 8215);
  redirects strip credential headers across origins.
- Confirmation codes are independent random secrets (no longer derivable
  from plan ids that appear in the audit tail); terminal plans refuse replay.
- Host header must be a loopback literal (DNS-rebinding defense); oversized
  bodies get 413 + socket destroy; audit reads are tail-bounded.
- Backup directories refuse junction/reparse traversal; atomic writes retry
  the Windows AV rename window; watchdog config is sha256-sealed.

## [0.1.0] - 2026-08-24

First public release of the zDSH Plugin Center: a built-in hub for
discovering, evaluating and safely installing DSH plugins from the web UI.

### Added

- **Marketplace discovery**: bounded 24-per-page listing with search,
  category filter, recommended-only toggle, three badges per entry
  (trust evidence, compatibility projection, pinned source), offline
  degradation to the bundled seed catalog.
- **Trust model**: GitHub targets pinned to exact 40-hex commits; catalog
  entries carry evidence levels (discovered/installable/verified/recommended);
  candidate pool is type-forbidden from carrying installable fields.
- **Safe lifecycle transactions**: one-shot plans with content-bound
  confirmation phrases → profile pre-hash → backup snapshot → pinned official
  CLI invocation (force-add forbidden) → post-state comparison → health probe
  → byte-exact verified rollback on any failure → secret-free JSONL audit.
- **Lifecycle script gate**: plans whose target declares unlisted
  lifecycle scripts are refused (`script_blocked`).
- **HTTP surface** under `/api2/zdsh-plugin-center/*`: same-origin
  enforcement, mutation intent header, read-only mode, bounded bodies,
  stable status-code mapping.
- **Self-guardian watchdog**: detached Node process probing a hardcoded
  loopback address, bounded restarts (3 per 5 minutes) with give-up state,
  status mirrored to disk; no launchd/schtasks/systemd required.
- **Web client**: settings section (order 30) with bilingual zh/en UI,
  theme alias variables, one-shot confirm dialog requiring the phrase code,
  boot guard refreshing once when the host reloads under a new boot id.
- Seed catalog with six verified, installable plugins.
- CI: lint + build + test on ubuntu and windows runners.

[0.2.0]: https://github.com/zsagi1368/zdsh-plugin-center/releases/tag/v0.2.0
[0.1.0]: https://github.com/zsagi1368/zdsh-plugin-center/releases/tag/v0.1.0

---

## 中文

## [0.2.0] - 2026-08-24

运维面、对抗加固与第一方注册表。

### 新增

- **守护接线**：`guardian/toggle` + `guardian/status` 路由驱动独立看门狗，启动命令与端口走配置。
- **备份管理**：快照列表 + 两阶段确认恢复（一次性 id/确认码，输错可重试直至成功或过期）。
- **卸载面**：客户端复用同款一次性确认弹窗。
- **签名远端目录**：远端快照必须携带匹配的 `catalog.json.sha256`，本地缓存同样验签；第一方注册表 `zsagi1368/zdsh-plugin-registry`。
- **闭环集成测试**：真 node:http + 真子进程 CLI 替身 + 真临时 profile（市场→staging→应用→审计→卸载→恢复→重放拒绝）。

### 加固（三轮对抗审查，复审至零 P0/P1）

- 命令参数白名单 + 目录字段字符集钉死，封死经目录字段的 shell 注入。
- SSRF 守卫判定完整 inet_aton 数字形式（十进制/短式/十六进制/八进制）、IPv4 兼容 ::/96 与 NAT64 嵌入（RFC 6052 + 8215）；重定向跨源剥离凭据头。
- 确认码改为独立随机一次性密钥（审计中的 planId 不再泄漏确认码）；终态计划拒绝重放。
- Host 头必须为环回字面量（DNS 重绑定防御）；超限请求体 413 + 断开连接；审计只读尾部 128 KiB。
- 备份目录拒绝 junction/reparse 穿越；原子写重试 Windows AV 重命名窗口；看门狗配置 sha256 封印。

## [0.1.0] - 2026-08-24

zDSH 插件中心首个公开版本：在 Web 界面中发现、评估并安全安装 DSH 插件的内置中枢。

### 新增

- **市场发现**：每页 24 条有界列表，支持搜索、分类过滤、只看推荐；每条目三徽章（信任证据、兼容性投影、固定来源）；离线时降级到随包种子目录。
- **信任模型**：GitHub 目标固定 40 位 commit；条目带四级证据；候选库在类型层面禁止携带可安装字段。
- **安全生命周期事务**：一次性计划 + 内容绑定确认语 → profile 前置哈希 → 备份快照 → 固定参数官方 CLI（禁止 force-add）→ 后置比对 → 健康探测 → 任一步失败逐字回滚并校验字节 → 无秘密 JSONL 审计。
- **生命周期脚本门禁**：目标声明未放行脚本时拒绝执行（script_blocked）。
- **HTTP 面** `/api2/zdsh-plugin-center/*`：同源校验、变更意图头、只读模式、请求体上限、稳定状态码映射。
- **自守护看门狗**：独立 Node 进程探测固定环回地址，5 分钟内最多重启 3 次后熔断放弃，状态落盘；不依赖 launchd/schtasks/systemd。
- **Web 客户端**：设置页分区（order 30），中英双语，主题别名变量，需输入确认码的一次性确认弹窗，宿主重载后 Boot Guard 单次刷新。
- 种子目录含六个已核实的可安装插件。
- CI：ubuntu 与 windows 双跑道的 lint + 构建 + 测试。
