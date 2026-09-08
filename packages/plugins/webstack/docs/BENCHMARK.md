# BENCHMARK — 全管线性能基准

- 生成方式：`pnpm --filter dsh-webstack bench`（离线确定性 fixture，seed=20260824；
  node 直接运行，不进 vitest/check 链）。
- 运行环境：node v24.19.0 · win32 x64 · AMD Ryzen 7 9800X3D 8-Core Processor
- 口径：最近邻秩百分位；搜索场景经 `WebstackAggregator.search/searchHits`
  全管线（hints→分档→计划→凭据快照→指纹→缓存→fallback/融合→seam 映射），
  每次场景前有 20 次预热不计样本；数据集逐字节可复现，计时为当次机器实测。

## 结果

| 场景 | n | p50 | p95 | mean | max |
| --- | --- | --- | --- | --- | --- |
| L0 缓存命中（search 全管线同键重放） | 300 | 0.008 ms | 0.015 ms | 0.010 ms | 0.237 ms |
| 免费池单引擎直出（free×1，miss 热路径） | 100 | 0.011 ms | 0.024 ms | 0.015 ms | 0.225 ms |
| 双引擎 RRF 融合（free×2） | 100 | 0.057 ms | 0.124 ms | 0.063 ms | 0.384 ms |
| fetchPipeline T1（静态抓取+抽取） | 100 | 0.110 ms | 0.275 ms | 0.144 ms | 0.388 ms |

缓存键指纹微基准：20,000 次 `keyFor`
（canonical JSON → sha256，双引擎维度输入）平均
**2518 ns/op ≈ 0.4 M ops/s**
（参考键 `8bd9579875c039e8…`）。指纹成本相对网络预算可忽略，
不设达标线（信息项）。

## 预算对照

| 预算项 | 阈值 | 实测 | 判定 |
| --- | --- | --- | --- |
| L0 缓存命中（全管线） | <50 ms | max 0.237 ms（n=300） | 达标 ✓ |
| 免费池单引擎直出（热路径） | ≤1.5 s | p95 0.024 ms | 达标 ✓ |
| 双引擎融合 | ≤8 s | p95 0.124 ms | 达标 ✓ |
| 抓取 T1（静态管线） | ≤5 s | p95 0.275 ms | 达标 ✓ |

**结论：全部场景达预算。**

## 方法说明

- **假 outbound**：`bench/outbound-mock.loader.mjs` 经 `module.register` 把
  `src/safety/outbound.ts` 替换为内存即回合的替身（~22 KB 确定性 HTML），
  fetchPipeline T1 腿零网络完成；搜索腿用脚本化假引擎（BaseEngine 包装，
  attempts/provenance 语义与真实适配器一致），同样零网络。
- **确定性**：查询词、命中 URL、页面内容全部由 mulberry32(20260824) 派生；
  单引擎/融合场景每循环换查询键以强制缓存 miss（测的是 miss 热路径），
  缓存命中场景则固定同键重放。
- **与 check 铁律的关系**：本目录不在 tsc/vitest/biome/tsdown 扫描范围内，
  基准代码的改动不影响 `pnpm -r run check && pnpm lint`。
