---
description: "zdsh 组地图：分叉自研底座——版本自适应兼容 shim、宿主侧治理内核及其宿主服务面、项目级插件根，以及钉住全部出厂预装插件的私有装配束。"
kind: "package-group"
---

# packages/zdsh（中文）

[English](README.md) | 中文

## 摘要

zdsh 组是 zDSH 自研底座的命名空间：本分叉新增的每一个件都位于 `packages/zdsh/*` 之下。`dsh-compat` 是唯一探测官方核心 API 形状的层；功能件经它对注册做门控，而非在漂移的启动期抛错。`plugin-governance` 与 `plugin-governance-host` 持有治理内核与面向第三方扩展的宿主服务面。`plugin-project-root` 发现项目级插件，钳制沙箱，经耐久信任账本守卫，并在启动后作为隔离的 Cordis 层挂载。`factory-bundle` 钉住每个出厂预装插件的 git URL 与完整 commit，一次 `pnpm install` 即把各工件落进工作区闭包。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`dsh-compat/`](dsh-compat/README.zh.md) | 动态 API 形状探测（`probeSymbol`）、功能守卫（`guardFeature`）与进程级兼容花名册；零运行时依赖 | —（进程级花名册） |
| [`plugin-governance/`](plugin-governance/README.zh.md) | 治理规范与内核：spec、registry、guards、sandbox、Cordis 适配器与持久化 | `ctx.pluginGovernance`（宿主 Remote 经 `plugin-governance-host`） |
| [`plugin-governance-host/`](plugin-governance-host/README.zh.md) | 宿主服务面：治理网关（`PluginGovernanceGateway`）、远端词汇表（`/types` `/typert` `/remote`）与出厂种子预装器 | —（宿主服务） |
| [`plugin-governance-ui/`](plugin-governance-ui/README.zh.md) | 治理台 UI client 件：roster 徽章、生命周期与准入动作、健康计数与预设，经 `pluginGovernance` Remote 投影 | —（client slots 件） |
| [`plugin-project-root/`](plugin-project-root/README.zh.md) | 项目级插件发现、宿主钳制、守卫、信任账本与启动后层挂载 | `ctx.projectPluginLayer` |
| [`factory-bundle/`](factory-bundle/README.zh.md) | 私有清单：八个出厂预装插件的 git URL + 完整 commit pin（`@deepseek-ai/zdsh-factory-bundle`）；不发布、无可执行源码 | —（依赖清单） |

-----

<a id="related-documentation"></a>
## 相关文档

- [zDSH 增强服务子系统](../../docs/subsystems/zdsh.zh.md) — 这些包提供的插件治理网关、项目插件层与出厂预装谱，及其守卫与沙箱语义。

-----
