---
description: "私有出厂工件包：为每一个 zDSH 出厂预装插件钉住 git URL + commit，令一次 pnpm install 即把各工件落入 workspace 闭包，供治理预装执行器就地纳管。"
kind: "package-reference"
---

# @deepseek-ai/zdsh-factory-bundle

[English](README.md) | 中文

## 概述

为每一个 zDSH 首启出厂预装的插件声明 git URL + 完整 commit pin；一次 `pnpm install` 即把各工件落入本包的 `node_modules` 闭包，治理 `SeedPreinstaller` 经既有 `local:` 安装通道就地纳管。新增或更新出厂预装插件时使用本包：在 `dependencies` 加一行，并配 `zdsh-factory/seed.json` 对应条目。本包从不搬运、复制或删除工件；每行必须携带 40-hex commit pin 与一条 Gate-P 探针。当前已钉八件，各件的出厂姿态记录于已知限制一节。

## 目录

- [使用本包](#use-this-package)
- [Model Experience](#model-experience)
- [已知限制与延后事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `dependencies` 下加一行 `<包名>: git+https://…#<40-hex commit>`，再跑 `pnpm install`，工件即落入本包的 `node_modules` 闭包。把 `zdsh-factory/seed.json` 对应条目的 `source` 指向解析到的目录即可。试点探针在 `tests/gate-p.spec.ts`。

## Model Experience

无——本包为私有依赖清单，不注册任何面向模型的内容。

#### KV Cache 影响

此处无任何内容进入请求前缀，provider 缓存复用不受影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后事项

- 未随附任何运行时 invariant companion；本包为私有依赖清单，无可执行源码、亦无需断言不变量的可变运行态。
- git 依赖会克隆仓库根，故 `dsh-webstack-verticals`、`dsh-webstack-bridge` 与 `dsh-webstack` 均解析到 WebStack monorepo，seed 的 `local:` 源分别指向其 `packages/verticals`、`packages/bridge`、`packages/webstack` 子目录；`dsh-omnivision`、`dsh-filehub`、`dsh-plugin-center`、`dsh-autopilot`、`zdsh-workbench` 为单包仓，其源直指 `node_modules/<包名>`。
- 当前已钉八件（verticals + omnivision + bridge + filehub + plugin-center + autopilot + webstack + workbench）；出厂姿态谱=六件挂载（omnivision + bridge + filehub + plugin-center + webstack + workbench——filehub/plugin-center 经 R-A 前置全套转绿后由 TC-B4-RA-2 翻为 `enabledAtBoot: true`；webstack 由 TC-B4-W3 按 W-DEC 裁决灌入出厂即用，且在 W1/W1b/W1c 契约修复链全绿之后；workbench 由 TC-O3 按用户 O-3 裁决灌入出厂即用，且在阶段 1 真源现代化链全绿之后——禁先灌 true 再修源）+ 两件跳过（verticals：包自述 opt-in；autopilot：ADJ-3 产品设计默认关）；其余接盘插件在后续批次加入。
- SSRF 双轨分工：走 webstack fetch/渲染路径的请求由插件自带 `checkTarget` 闸把关（`safety/ssrf.ts`，按解析后 IP fail-closed）；走宿主内置 http fetch 路径的请求由平台四闸链把关（policy/network/provider 逐跳 + 有界体）。bridge 的 JS 渲染回退经其 `dsh-webstack` peer import 复用插件闸（peer 缺席时 fail-closed）。

<a id="dev-note"></a>
### 开发备注

在此新增依赖属供应链变更：必须携带 40-hex commit pin（禁用分支或浮动区间），且每条新条目须配 `zdsh-factory/seed.json` 对应行与一条 Gate-P 探针。
