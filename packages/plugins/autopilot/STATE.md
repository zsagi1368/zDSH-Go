# STATE — zdsh-autopilot 战役看板

> 恢复会话先读本文件。规划全文：`../plan/00-overview.md`（00–07）。本仓库 = 独立插件 `github.com/zsagi1368/zdsh-autopilot`。**分支集成冻结中**（等用户明确指令）。

## 当前位置

- 里程碑：**M0′ 脚手架 → M1 kernel**
- 最近更新：2026-08-24

## 里程碑状态

| 里程碑 | 状态 | 出口证据 |
|---|---|---|
| M0′ 独立脚手架 | ✅ 完成 2026-08-24 | 建仓+首推；lint/typecheck/test/build 全绿 |
| M1 kernel | ✅ 完成（4bf69c6） | 七模块+facade 冻结，53→83 测试 |
| M2 continue | ✅ 完成（d705e49） | 状态机/循环守卫/语料外置，83 测试 |
| M3 guard | ✅ 完成（ca3e083） | 四级栈/词法器/工件身份/越权桥，109 测试 |
| M4 review | ✅ 完成（ca3e083） | 应答合取/熔断/反馈回路，124 测试 |
| M5 console | ✅ 完成（0d256e0） | /ap 命令/桥鉴权/官方槽位 UI/双语词典，134 测试 |
| M6′ 发布 | ✅ 完成 2026-08-24 | eval 引擎+10 用例全过；双轮对抗门禁 0 失败；pack 冒烟通过；v0.1.0 tag + Release |
| 集成期 | 🔒 冻结 | 用户指令后按 plan/07 E4 执行 |

最终门禁：`pnpm verify` = lint(边界+原创性扫描) + typecheck(三 tsconfig) + vitest 134 + 双面构建 + 离线评测 10/10。

## 关键决策备忘（详见 plan/07）

- 独立包名 `zdsh-autopilot`，行 id `autopilot`；宿主包 devDeps 钉 `0.1.2-rc.1`（registry 离 zDSH 0.1.3-alpha.1 基线最近的可复现快照），peer `>=0.1.0-rc.2` optional。
- **0.1.3-alpha.1 兼容性验证（2026-09-07）**：本仓零编译期 dsh import，类型面兼容平凡；运行时面 6 service key + 4 过滤事件类型经核对 0.1.3 全健在，无 session v2 夹具依赖；`pnpm run verify` 全绿（134 测试 + eval 10/10）。官方发布 0.1.3-alpha.1 到 npm 后机械 bump 即可。
- npm dist-tag `latest` 滞后（0.0.1-rc.1）是已知现象，勿据此改钉子。
- 共享文件白名单在独立期为 **0**；集成期才启用（web-app patch 一行 + 可选 tsconfig 行）。

## 抢救协议

代理沉默死亡后：先 `git log --oneline -5` + `git status` 盘点已落盘工作 → 重跑门禁验证 → 由主控补提交 → 重派任务时在任务书里写明"已完成部分勿重做"。

## 门禁速查

`pnpm verify`（= lint + typecheck + test + build；勿用 `pnpm ci`，那是 pnpm 内置冻结安装）；eval 引擎落地后并入。提交前必跑。
