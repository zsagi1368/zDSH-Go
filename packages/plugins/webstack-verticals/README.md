# dsh-webstack-verticals（实验性·默认关闭·用户显式开启）

> **Experimental · off by default · explicit user opt-in only.**
> 实验性 · 默认关闭 · 须用户在设置中显式开启（`verticals.packEnabled` 与逐频道
> 开关默认均为 `false`）。本包不改变 dsh-webstack 内核任何默认行为。

WebStack Verticals (网栈·垂) — vertical-channel satellite package (**host side**)
for the [dsh-webstack](../webstack) plugin family.

## 结构

- `src/framework.ts` — 垂直频道最小框架：`VerticalChannel` 接口 +
  `VerticalRegistry`（register/list/canRun）。类型为 W-B-05 同款本地结构镜像，
  与 dsh-webstack 冻结契约结构兼容，本包对其零 import 依赖、monorepo 外可编译。
- `src/x-search.ts` — 合规版免凭据 X 检索降级链：
  - 腿 1：经装配层注入的 `deps.search` 免费池回调执行
    `site:x.com OR site:twitter.com <topic>`，取得结果列表；
  - 腿 2：对其中 `/status/<id>` 形态的推文 URL 逐个调用官方公开端点
    `https://publish.twitter.com/oembed?url=<enc>&omit_script=true&dnt=true`
    （GET；出站经注入的 `outboundFetch`，缺席即结构探测失败 → 静默跳过），
    用返回的 html 富化 snippet 并标注 `provenance.via = 'oembed'`；
  - 两腿全失败返回空数组，绝不抛错；所有结果如实带 via 标注（W-B-17）。
  - 并发治理：同主题单飞防重；每 URL 一次会话内 oEmbed 缓存。

## 合规姿态

- 不抓取、不绕过登录墙：只消费免费池引擎的公开检索结果与 X 官方 oEmbed
  端点的公开输出；不带凭据、不伪装会话、不发自动化浏览流量。
- descriptor id `x-vertical`，tier `free`，caps.vertical；keysRequired 恒 0。

## 测试

```bash
pnpm test   # 全离线：search/outboundFetch 均为注入替身，不出网
```
