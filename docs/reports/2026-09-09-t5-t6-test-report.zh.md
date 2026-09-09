# T5+T6 测试报告 — zDSH-go 战役全量门禁 + 端到端安装验证

[English](2026-09-09-t5-t6-test-report.md) | 中文

> tester 执行；日期 2026-09-09；worktree `G:\000Github\zDSH\zDSH-wt\zDSH-go`（分支 zDSH-go，起测 HEAD=d87c48f87e，新增 commit 4d3a99d847）。证据文件（worktree 内相对路径）：/tmp 日志已摘录进本报告，关键原始日志见 `del/20260909-053849-t5-config-catalog-gate-fix/` 旁的 ops 交接与下文逐项引用。

## T5 全量门禁（8 项）

| # | 门禁 | 结果 | exit | 证据摘要 |
|---|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | PASS | 0 | 288 workspace projects up to date，366ms（pnpm 11.7.0） |
| 2 | `pnpm build:lib:host` | PASS | 0 | tsc -b host（223+ references）+ tsdown host face 全绿 |
| 3 | `pnpm build:lib:client` | PASS | 0 | ui-conversation/client 等全绿 |
| 4 | `pnpm build:lib:plugins` | PASS | 0 | filehub(node build.mjs)+webstack(host+client)+autopilot+omnivision(vite 11 modules 58.01kB) 4/4 |
| 5 | gen+verify cordis / client catalog | PASS | 0 | cordis 99 artifacts up to date；client slot-catalog up to date |
| 6 | config-catalog 缺口修复 | PASS（tester-gate-fix） | 0 | 详见下节；commit `4d3a99d847` |
| 7 | 全量 vitest | PASS（含 1 个已定性抖动） | 1→热态复跑 0 | 12 failed = 基线 11 + client-build-environment ×1（6467ms 冷缓存超时；热态复跑 8/8 PASS）。基线 11 与 `del/20260908-190506-core-patches/evidence/.t1-baseline.log` 完全一致（ui-settings-models ×9 + ui-theme corner-shape ×1 + elevation ×1） |
| 8 | lint 全仓（oxlint） | PASS | 1（预期） | 13 errors ≤ 16（T2a 基线）；0 个落在 `packages/plugins/`（新包零落点） |

vitest 总量：18174 passed / 12 failed / 76 skipped（1142 test files）。

### T5-6 config-catalog 修复明细（单独 commit `4d3a99d847`，message 注明 tester-gate-fix）

8 个 violations → 0，全部为 vendored 适配（门禁面），零运行时逻辑变更：

1. `zdsh-dsh-guard` entry 缺失 → 新增 `packages/plugins/dsh-guard/src/index.ts` 纯 catalog 扫描标记（export {}，库类；真实产物 dsh-guard.mjs 与 package.json main 不变）。
2. `zdsh-filehub` 引用 `Partial` 未声明 → 新增 `export type FileHubPluginConfig = Partial<FileHubConfig>` 并让 apply 签名改用该别名（类型擦除等价）；连带补 FileHubConfig/VisionDomainConfig/ReadingBudgets 成员 JSDoc（默认值均经源码核实：cacheEntries=64、cacheBytes=256MiB、maxEntries=2000）+ ReadingBudgets type import 改 `.ts` 扩展（仓库 `allowImportingTsExtensions` 惯例）。
3. `dsh-webstack-bridge` Config freeze 不可走查 → `export const Config = Object.freeze(…)` 改 `const configSchema = Object.freeze(…)` + `export { configSchema as Config }`（同一冻结对象、同一导出名；cordis fiber.ts:53 仍按 `Config['~standard'].validate` 校验，运行时等价已静态核实）。
4. `dsh-webstack` McpServerEntry 5 字段补 JSDoc prose。

回归证据：gen+verify-config-catalog exit 0；build:lib:host 复跑 exit 0；filehub+webstack-bridge vitest 402 passed；webstack 包内 vitest 684 passed。备份：`del/20260909-053849-t5-config-catalog-gate-fix/`（RESTORE.md + SHA-256 对齐）。

## T6 端到端安装验证

| 项 | 结果 | 证据 |
|---|---|---|
| ① install.ps1 | PASS exit 0 | 4/4 步全绿；产物 `env.ps1`/`env.sh`/`data/`（保留给用户检查：`G:\000Github\zDSH\zDSH-wt\zDSH-go\data`）。附带发现 [P2] guard check 定位错误，见缺陷表 |
| ② CLI 启动 | PASS | `node apps/cli/lib/bin.js --version` → `0.1.3-alpha.1` exit 0；`dsh web --help` 面正常 |
| ③ 6 插件加载证据 | **FAIL（P0 阻断）** | web profile boot 崩溃于 dsh-omnivision，见缺陷表。静态 unwrap 核验：filehub/webstack/autopilot/plugin-center/webstack-bridge 5/6 形态 OK（default 或 apply 可达），omnivision 无 default 无 apply |
| ④ web 面可达 | **FAIL（被 ③ 阻断）** | 4173/4174 无监听（`--noproxy` curl 000/refused；无 --noproxy 时的 503 系本机代理回复，非服务） |
| ⑤ uninstall 默认模式 | PASS | 沙箱干跑 + 全文逻辑核读：git clean -Xdf（del/ 区以 `!del/**` 临时负向规则守卫）+ [2/2] REMAINS 清单 |
| 对照 A 哨兵双向 | PASS ×2 | 方向1（不 source env、DSH_BRANCH_HOME=哨兵）：boot 崩溃前 workbench/tasks.json 已落哨兵 `…/sentinel/workbench/tasks.json`（显式覆盖生效）。方向2（source env 钉死 data/zdsh）：哨兵 0 文件，`data/zdsh/workbench/tasks.json` 落位（钉死生效） |
| 对照 B -CleanLegacy | PASS | 临时 USERPROFILE 沙箱：`.dsh-zdsh/MAIN-TREE-MARKER.txt` 原样保留；`.dsh-zdsh-go` 被清；官方 `.dsh` 未给 -Yes 时 [kept]；exit 0 |
| 对照 C seed-only | PASS | remote 404/不可达（含 .sha256 双请求）→ fallback `mode: seed`，6 条目全列（sliverp/dsh-hub-plugin 等）；脚本即改即删，未入库 |

## 缺陷报告（P0–P3）

**[P0] zDSH-go web profile 无法启动：dsh-omnivision 挂载被 cordis 拒绝**
- 复现（最小）：`cd G:\000Github\zDSH\zDSH-wt\zDSH-go && source env.sh && node apps/cli/lib/bin.js web --no-open --port 4173`
- 期望：web profile 启动，6 挂载插件（workbench/filehub/zdsh-plugin-center/autopilot/dsh-webstack/dsh-omnivision）全部 apply，4173 可达。
- 实际：`Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to apply loader entry dsh-omnivision (dsh-omnivision): invalid plugin, expect function or object with an "apply" method, received object`，进程 exit 非零，web 面无监听。
- 根因（tester 定性，供 coder 参考）：omnivision 为工厂形态（`createOmnivisionPlugin(ctx)` / `class OmniVisionPlugin`，构造需 PluginContext），dist 无 default、无 apply 导出；loader `unwrapExports`（vendor/loader/src/index.ts:192-199）取 `default ?? namespace` 后得裸 namespace，cordis registry（vendor/cordis/src/registry.ts:326）按 function/`apply`-object 校验拒绝。其余 5 个挂载包 unwrap 形态已逐一静态核验 OK。上游仓自带 cordis.patch.yml 也是 `name: 'dsh-omnivision'` 直挂，说明独立仓场景下存在未 vendor 进来的适配层（或上游未真正走 cordis 直挂路径）。修复方向（二选一，归 coder）：① omnivision 入口补 `export default { apply }`/工厂适配薄壳（需 ctx 到 PluginContext 的映射）；② 挂载 patch 改指适配包装包。T3 警告的「运行时才爆」命中。
- 影响：zDSH-go 整包不可用（安装可完成但无任何 web 服务），T6-③④ 全断；发布门阻断。

**[P2] install.ps1 第 2b 步 dsh-guard check 扫描真实主树路径**
- 复现：fresh install 后看 install 日志 `[dsh-guard …] ERROR profile 不存在: C:\Users\ZS\.dsh\profiles\web`。
- 期望：D5 语境下守卫应检查本安装的 profile（`<repo>/data` 面）或 fresh install 语义下明确跳过。
- 实际：guard 用真实 `C:\Users\ZS\.dsh`（官方主树 home-paths 常量），fresh install 必然 exit 2（虽按设计非阻断）。
- 影响：守卫接线「永远在错误目录上报警/漏报」，D5 的「只接会真实运行的路径」目标打折；不阻断发布（警告面），建议派卡把 guard 的 profile 定位钉到 `<repo>/data` 或传入 DSH_HOME。

**[P3] pnpm install 报 cyclic workspace dependencies 警告**
- 证据：install 日志列出 7 组环（多为上游既有，如 vendor/cordis ↔ vendor/include；vendored 面未见新增环）。
- 影响：无功能影响，记录备查。

## 通过清单（可直接引用）
- T5：1✔ 2✔ 3✔ 4✔ 5✔ 6✔（tester-gate-fix commit 4d3a99d847）7✔（11 基线一致+1 已定性抖动）8✔（13≤16，新包 0）。
- T6：①✔ ②✔ ③✘(P0) ④✘(被③阻断) ⑤✔；对照 A✔✔ 对照 B✔ 对照 C✔。

## 结论
- T5 验收门：**全过**（门禁面无阻断遗留；config-catalog 修复已独立 commit 供 reviewer 复核）。
- T6 验收门：**不过**——P0（omnivision 挂载崩溃）阻断发布门；需主线派卡 coder 修复后重跑 T6-③④（最小复跑面：web boot 日志逐插件加载行 + curl /workbench 与 /plugins/*/client.js）。
- 本报告与 data/ 安装产物保留在 worktree，供 ops/reviewer 检查；%TEMP% 沙箱目录 `/tmp/zsh-go-e2e` 已用后自清（见下）。

## 附：临时环境清理记录
- `%TEMP%\zsh-go-e2e`（沙箱 HOME、哨兵目录、uninstall 沙箱仓）属测试自建，脚本清理不涉零风险协议原件。
- worktree 内 `data/`、`env.ps1`、`env.sh` 为安装产物，按任务卡保留给用户检查。
