# 已发布 zDSH-Go 的全新克隆端到端验证（战役 E，最终验收）

[English](2026-09-09-fresh-clone-e2e.md) | 中文

- 日期：2026-09-09
- 执行者：tester（独立验收，未修任何代码）
- 被验对象：已发布仓库 `https://github.com/zsagi1368/zDSH-Go.git`，严格按仓库 README Quick Start 在全新克隆中全真走通
- 结论：**PASS——发布门通过。0 个阻断缺陷（P0/P1：无；P2：无；P3：2 条观察记录，入 backlog）。**

## 1. 环境

| 项 | 值 |
| --- | --- |
| 克隆目标 | `%TEMP%\zshgo-e2e\clone\zDSH-Go`（任务专用临时目录，自建自清） |
| Node / pnpm / git / curl | v24.19.0 / 11.7.0（install 输出）与 11.25.0（shell）/ 2.54.0.windows.1 / 8.19.0 |
| 真实 `$HOME` | 未触碰（uninstall 前已快照基线，见第 6 节） |
| 隔离 | 安装器生成的 `data/` 数据home（`DSH_HOME=<repo>/data`），服务绑定 `127.0.0.1:4182`；全部探针走本地回环并设置 `--noproxy` |

## 2. 克隆与 README 事实核对

| # | 检查 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | `git clone https://github.com/zsagi1368/zDSH-Go.git` | PASS（exit 0，9756 个文件） | HEAD `02b2f21b11fd0810c791aa3d4e788b29a4c06180` = 预期 `02b2f21b11` |
| 2 | README.md / README.zh.md 内容 = worktree 定稿 | PASS | 与 worktree 逐字节一致（`md5` `271b0d53…` / `f3642a4e…`）；抽样 3 段人工核对：Quick Start（L53–107）、Security（L144–149）、FAQ/License/Acknowledgements（L151–174） |
| 3 | 根 `install.cmd` 存在 | PASS | 92 字节包装器 → `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1`，与 worktree 一致 |

## 3. 安装（README Quick Start，`install.cmd`）

以 `cmd //c install.cmd` 运行（即 README 的 Windows 指引 `.\install.cmd`；`powershell -File install.cmd` 无效，因为 `-File` 只接受 `.ps1`——见 P3-b）。

退出码：**0**。各步输出：

| 步骤 | 输出摘录 |
| --- | --- |
| 前置检查 | `[OK] Node.js v24.19.0` / `[OK] pnpm 11.7.0` |
| [1/4] `pnpm install --frozen-lockfile` | `Done in 50.8s using pnpm v11.7.0`；WARN：两个仅限 Linux 的 `landlock-run` 可选包在 win32 跳过、循环 workspace 依赖列表、4× `Failed to create bin …bin.js.EXE`（P3-a） |
| [2/4] `pnpm run build` | 完成，exit 0；仅构建工具 WARN（`external` 弃用、一处 INEFFECTIVE_DYNAMIC_IMPORT） |
| [2b/4] `dsh-guard check --profile web` | `[dsh-guard …] ERROR profile 不存在: …\data\profiles\web` → `[WARN] … continuing (non-blocking)`——与 README 声明的全新安装行为完全一致 |
| [3/4] data 目录 | 创建 `<repo>/data` |
| [4/4] env 文件 | 写入 `env.ps1`（UTF-8 BOM）/ `env.sh`（无 BOM）；`dsh` = `node <repo>/apps/cli/lib/bin.js` |
| 收尾 | `zDSH-go installed successfully (self-contained).` `DSH_HOME=<repo>\data`、`DSH_BRANCH_HOME=<repo>\data\zdsh`、`DSH_AGENTS_HOME=<repo>\data\agents` |

## 4. 启动（README Run 段）

- `source ./env.sh && dsh web --no-open --port 4182`
- 启动日志（单行，干净）：`dsh web: http://127.0.0.1:4182/?token=…`
- 进程：node.exe PID 90232；`netstat` → `TCP 127.0.0.1:4182 … LISTENING`；+12s 与 +24s 两次确认存活（此后持续运行约 13 分钟直至主动停止）
- 日志扫描：`failed-to-apply` / `failed to apply` / `error` 出现 0 次
- 认证模型实测：未认证 `GET /` → **401**（设计如此）；`GET /?token=<启动token>` → **303 + set-cookie**（`dsh-auth-<authority>`，HttpOnly、SameSite=Strict、30 天有效期）；后续所有探针携 cookie 认证

## 5. 九项整合活体探针（全部 PASS）

全部探针经回环、携 token 换发的 cookie、设置 `--noproxy`。基线根检查：`curl /` → **200**（带 cookie）。

| # | 探针 | 端点 / 方式 | 结果 | 证据摘录 |
| --- | --- | --- | --- | --- |
| 1 | workbench ping + HTML | `GET /workbench/api/ping` + `GET /workbench` | PASS | ping → 200 `{"ok":true,"value":{"ok":true,"plugin":"@deepseek-ai/dsh-client-workbench","version":"0.1.3-alpha.1"}}`；HTML → 200，26172 字节（SPA module-loader 外壳） |
| 2 | filehub usage | `GET /api/filehub/usage` | PASS | 200 `{"totalBytes":0,"files":0,"byKind":{image,document,text,binary,media…},"bySession":[]}` |
| 3 | plugin-center market | `GET /api2/zdsh-plugin-center/market` | PASS | 200，`total=6`；6 条，id + pinnedCommit 与 catalog 一致（见 #9） |
| 4 | autopilot dump-config insert 行 | `dsh --profile web --dump-config` | PASS | exit 0，556 行；autopilot 条目在场（L543–551）：`id: autopilot / name: zdsh-autopilot / modules: continue|guard|review enabled: true`；溯源到 bundle 补丁 `packages/plugins/autopilot/cordis.patch.yml` 的 `insert:` 行。说明：渲染后的 dump 将 insert 行物化为条目（dump 输出无字面 `insert` 关键字）——语义已端到端验证 |
| 5 | webstack dump-config + Aggregator 可导入 | dump + ESM 导入构建产物 | PASS | dump 含 `- id: dsh-webstack / name: dsh-webstack`；`import('…/packages/plugins/webstack/lib/index.js')` 成功，`typeof WebstackAggregator === 'function'`，插件 `name === 'webstack'` |
| 6 | omnivision toolRegistry 9 工具 | ESM 导入 `packages/plugins/omnivision/dist/index.js` | PASS | 13 个导出含 `toolRegistry`/`listTools`；`listTools()` 恰好 9 个：`vision_describe`、`vision_ocr`、`vision_detect`、`vision_ground`、`vision_bootstrap`、`vision_crop`、`vision_pixel_diff`、`vision_trace`、`vision_screenshot` |
| 7 | attachment-local dump-config 值 | dump L64–69 | PASS | `maxImageBytes: 20971520`（20 MiB）、`maxImagePixels: 100000000`（100 MP）、`maxImageDimension: 10000`（px）——与预期一致；仓库级裸默认（64 MP / 8192 px）由 web profile 补丁层覆盖为 100 MP / 10000 px，属设计行为 |
| 8 | dsh-guard install 日志行 | install 输出 + 追加验证 | PASS | install 输出含 `[2b/4] dsh-guard check` 块及 `[dsh-guard <ts>]` 日志行（全新安装时 profile 不存在告警属预期）；启动后 `dsh-guard check --profile web` → `体检通过：无偏差` exit 0；`dsh-guard install --profile web` → prepare 钩子注册成功、`install: 执行首次体检+修复…`、`unclean 检查通过：无需修复`，exit 0 |
| 9 | PluginCenter seed 6 条 = PluginRegistry catalog | seed.json vs 远端 catalog.json vs 活体 market | PASS | `packages/plugins/plugin-center/catalog/seed.json`：6 条；远端 `https://raw.githubusercontent.com/zsagi1368/zdsh-plugin-registry/main/catalog.json`：6 条；id + pinnedCommit 逐一相同且顺序一致（`sliverp/dsh-hub-plugin@2b21934…`、`AI-Scarlett/dsh-safe-plugin-manager@47ad35b…`、`zsagi1368/zdsh-autopilot@d705e49…`、`omdsh-dev/DSH-better-sidebar@36a4119…`、`taxueseek/dsh-files@b17e36f…`、`HongMing-Huang/dsh-file-upload@ce4ca94…`）；活体 market API 返回同样 6 条 |

## 6. 卸载（默认模式）与 `$HOME` 保护

- `cmd //c uninstall.cmd` → exit **0**
- `[1/2] Cleaning gitignored artifacts inside the repository`——node_modules、构建产物、data、env 文件全部清除
- `[2/2] Zero-residue checklist`：node_modules / lib / data / env.ps1 / env.sh → 全部 `[clean]`；`~/.dsh-zdsh-go` → `[clean]`；`~/.zdsh-workbench` → `[REMAINS] (use -CleanLegacy to remove)`；收尾 `Result: some items remain`——仅由下述既有 legacy 目录导致
- **REMAINS 语义验证正确**：`~/.zdsh-workbench/tasks.json` 早于本次会话（mtime 2026-09-01 20:04，为更早一次未设 DSH_HOME 的 workbench 运行所建；ledger 在无 `DSH_BRANCH_HOME`/`DSH_HOME` 时回退 `~/.zdsh-workbench`）。卸载器如实报告并保留——保守、符合设计；不经 `-CleanLegacy` 绝不删除
- `$HOME` 保护：uninstall 前基线 → `.dsh` 存在（5 个文件）、`.dsh-zdsh` 不存在、`.dsh-zdsh-go` 不存在；uninstall 后 → 完全一致。官方 `~/.dsh` 只有 `-CleanLegacy` 加交互式 `yes` 确认才能触达（默认模式绝不触碰）
- 仓库完整性：`git status --porcelain` 为空，HEAD 仍为 `02b2f21b11`

## 7. 清理与残留检查

- 测试服务已停止（taskkill；首次非强制 `taskkill /PID` 被拒——Windows 对无控制台信号处理器的 node 进程属正常行为——随后 `/F`）。端口 4182 已释放（netstat 为空）
- 未发现命令行含 `zshgo-e2e` 的 node 进程残留
- 克隆目录整体删除（任务专用临时目录，自建自清；测试日志保留在临时工作区至会话结束）

## 8. 缺陷 / backlog

**P0：无。P1：无。P2：无。** 发布门不受阻。

| 严重级 | 编号 | 观察记录 | 建议归属 |
| --- | --- | --- | --- |
| P3 | E-P3-a | 全新 `pnpm install --frozen-lockfile` 输出 4× `[WARN] Failed to create bin …bin.js.EXE (ENOENT)`——pnpm 在 `pnpm run build` 产出 `apps/cli/lib/bin.js` 之前先链接 workspace bin。非阻断（env.ps1/env.sh 直接以路径定义 `dsh`；安装后运行正常）。每次全新安装都有装饰性噪音 | backlog（coder） |
| P3 | E-P3-b | 任务卡用语 `powershell -File .\install.cmd` 不可行（`-File` 只接受 `.ps1`）；README 指引 `.\install.cmd` 正确。仅为文档措辞——仓库无需改动 | 已记录，无需动作 |

非缺陷确认：未认证 `/` → 401 是设计内的认证模型；`dump-config` 将 `insert` 行物化是渲染器的既定行为。

## 9. 结论

已发布的 zDSH-Go 仓库通过全部全新克隆验收：克隆 → 安装（exit 0）→ 启动（监听健康、日志干净、token→cookie 认证可用）→ 9/9 活体探针 PASS → 卸载（exit 0，REMAINS 语义正确，`$HOME` 未触碰）→ 干净收场。README Quick Start 准确且可复现。**给 ops 的建议：发布门放行。**
