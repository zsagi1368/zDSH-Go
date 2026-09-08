#!/usr/bin/env node
/**
 * WebStack 全管线性能基准（离线确定性；node 直接运行，不进 vitest）。
 *
 *   pnpm --filter dsh-webstack bench
 *   （等价：node --experimental-transform-types bench/pipeline.bench.mjs）
 *
 * 方法：
 * - 假 outbound（bench/outbound-mock.loader.mjs 经 module.register 注入）让
 *   fetchPipeline 的 T1 腿在内存即时回合；搜索腿用脚本化假引擎（不触安全管道）。
 * - 全部 fixture 由固定 seed（mulberry32 @ 20260824）派生：同一 Node 版本下
 *   数据逐字节可复现；计时本身当然是机器相关的。
 * - 场景（与预算对照，详见 docs/BENCHMARK.md）：
 *     1. L0 缓存命中全管线            预算 <50 ms
 *     2. 免费池单引擎直出 p50/p95    预算 ≤1.5 s（100 循环）
 *     3. 双引擎 RRF 融合 p50/p95     预算 ≤8 s（100 循环）
 *     4. fetchPipeline T1 p50/p95    预算 ≤5 s（100 循环）
 *     5. 缓存键指纹 keyFor 微基准    信息项（无预算）
 * - 结果打印 stdout 表格并覆写 docs/BENCHMARK.md。
 *
 * 本脚本与 bench/ 目录均在 check 链（tsc / vitest / biome / tsdown）之外。
 *
 * @module bench/pipeline.bench
 */

import { writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 出站替身注册 + 源码装载（动态导入保证钩子先于 outbound.ts 的首次加载生效）
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
await register('./outbound-mock.loader.mjs', import.meta.url);

const { WebstackAggregator } = await import('../src/kernel/aggregator.ts');
const { BaseEngine, FREE_POOL_ENGINE_IDS } = await import('../src/engines/engine.ts');
const { keyFor } = await import('../src/cache/store.ts');
const { fetchPipeline } = await import('../src/fetch/pipeline.ts');

// ---------------------------------------------------------------------------
// 固定 seed fixture 与统计工具
// ---------------------------------------------------------------------------

/** 固定 seed：任何一次运行的数据集都由此确定性派生。 */
const SEED = 20260824;

/** mulberry32 PRNG（32 位，确定性）。 */
function mulberry32(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEXICON = [
  'webstack',
  'aggregator',
  'fusion',
  'cache',
  'fingerprint',
  'pipeline',
  'engine',
  'router',
  'hints',
  'cooldown',
];

/** 由 seed 构造 N 条互异查询（长度 >16 字符 → 复杂档，路由宽度=整池）。 */
function buildQueries(count) {
  const rng = mulberry32(SEED);
  const queries = [];
  for (let i = 0; i < count; i++) {
    const w1 = LEXICON[Math.floor(rng() * LEXICON.length)];
    const w2 = LEXICON[Math.floor(rng() * LEXICON.length)];
    queries.push(`bench ${w1} ${w2} deterministic probe q${i}`);
  }
  return queries;
}

/** 单引擎 fixture 集：首条公共 URL + 引擎私有 URL（供融合去重/并集路径做功）。 */
function scriptedHits(queryIndex, engineTag, count) {
  const hits = [];
  for (let i = 0; i < count; i++) {
    const common = i % 3 === 0;
    const url = common
      ? `https://common.example/topic/${queryIndex}/${Math.floor(i / 3)}`
      : `https://${engineTag}-${(queryIndex * 7 + i) % 89}.example/r/${queryIndex}/${i}`;
    hits.push({
      url,
      title: `${engineTag} result ${queryIndex}-${i}`,
      snippet: `Deterministic snippet for ${engineTag} at index ${queryIndex}/${i}.`,
      provenance: { engine: engineTag },
    });
  }
  return hits;
}

/** 最近邻秩百分位：sorted 为升序样本（毫秒）。 */
function percentile(sorted, q) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/** 样本摘要：p50 / p95 / mean / max（毫秒）。 */
function stats(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    mean: sum / sorted.length,
    max: sorted[sorted.length - 1],
  };
}

/** 高精度单次计时（毫秒）。 */
async function timeOnce(fn) {
  const started = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function measure(warmup, iterations, makeCall) {
  for (let i = 0; i < warmup; i++) await makeCall(i);
  const samples = new Array(iterations);
  for (let i = 0; i < iterations; i++) samples[i] = await timeOnce(() => makeCall(i));
  return stats(samples);
}

// ---------------------------------------------------------------------------
// 假引擎与聚合器装配
// ---------------------------------------------------------------------------

/** 脚本化免费池假引擎：纯内存取数，provenance 盖章/attempts 审计走真 BaseEngine。 */
class ScriptedEngine extends BaseEngine {
  constructor(id) {
    super({
      id,
      kind: 'search',
      tier: 'free',
      caps: {},
      cost: { keysRequired: 0 },
      latencyBudgetMs: 50,
    });
    this.calls = 0;
  }

  async search(req) {
    this.calls++;
    const queryIndex = Number.parseInt(/q(\d+)\s*$/.exec(req.hints.topic ?? '')?.[1] ?? '0', 10);
    return await this.runSearch(req, async () =>
      scriptedHits(queryIndex, this.descriptor.id, req.count),
    );
  }
}

function snapshotOf(extra) {
  return {
    enabled: true,
    layer: 'free',
    autoFallback: true,
    maxResults: 8,
    fusionEnabled: true,
    complexityRouting: true,
    fetchMode: 'raw',
    maxContentChars: 12_000,
    ssrfExempts: [],
    cacheEnabled: true,
    ...extra,
  };
}

/** 装配一个带指定假引擎的聚合器（每次场景独立实例，缓存互不串扰）。 */
async function buildAggregator(engineIds, extraSnapshot) {
  const { EngineRegistry } = await import('../src/kernel/registry.ts');
  const registry = new EngineRegistry();
  for (const id of engineIds) registry.register(new ScriptedEngine(id));
  return new WebstackAggregator({ snapshot: snapshotOf(extraSnapshot), registry });
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const QUERIES = buildQueries(140);

/** 场景 1：L0 缓存命中（同键反复 search 全管线，含指纹计算与 seam 映射）。 */
async function benchCacheHit() {
  const agg = await buildAggregator([FREE_POOL_ENGINE_IDS[0]]);
  await agg.search({ query: QUERIES[0], maxResults: 8 }); // 预热并写入 L0
  if (agg.cache.stats().hits === 0 && agg.cache.stats().misses === 0) {
    throw new Error('cache did not record the warm-up call');
  }
  const result = await measure(20, 300, () => agg.search({ query: QUERIES[0], maxResults: 8 }));
  if (agg.cache.stats().hits < 300) throw new Error('expected pure L0 hits');
  return result;
}

/** 场景 2：免费池单引擎直出（每循环换键强制 miss，走 fallback 直出+写缓存）。 */
async function benchSingleEngine() {
  const agg = await buildAggregator([FREE_POOL_ENGINE_IDS[0]]);
  const queries = QUERIES.slice(0, 100);
  const result = await measure(
    20,
    100,
    (i) => agg.search({ query: queries[i % queries.length], maxResults: 8 }),
  );
  if (result.p50 <= 0) throw new Error('degenerate timing');
  return result;
}

/** 场景 3：双引擎 RRF 融合（复杂档整体预算 race 语义在场，腿即时归）。 */
async function benchFusion() {
  const agg = await buildAggregator([...FREE_POOL_ENGINE_IDS.slice(0, 2)]);
  const queries = QUERIES.slice(40, 140);
  const result = await measure(
    20,
    100,
    (i) => agg.search({ query: queries[i % queries.length], maxResults: 8 }),
  );
  const sources = await agg.search({ query: 'fusion sanity probe q0', maxResults: 8 });
  if (sources.sources.length === 0) throw new Error('fusion scenario produced zero sources');
  return result;
}

/** 场景 4：fetchPipeline T1（出站替身 ~22 KB HTML → 抽取回退链全链路）。 */
async function benchFetchT1() {
  const budgets = {
    canonicalChars: 48_000,
    renderedChars: 12_000,
    errorChars: 2000,
  };
  const result = await measure(20, 100, async (i) => {
    const fetched = await fetchPipeline({
      url: `https://bench-fixture.example/page/${i}/t1`,
      mode: 'raw',
      budgets,
    });
    if (fetched.statusCode !== 200 || fetched.content.length === 0) {
      throw new Error('fixture fetch returned an empty page');
    }
  });
  return result;
}

/** 场景 5：缓存键指纹微基准（keyFor = canonical JSON → sha256）。 */
function benchKeyFor() {
  const input = {
    layer: 'free',
    engineSet: ['ddg', 'bing-lite'],
    count: 8,
    hints: { topic: 'bench fingerprint probe', hard: ['site:example.com'], soft: ['recent'] },
    tier: 'free',
    credFingerprint: '0f60e5a7',
  };
  const reference = keyFor(input);
  if (!/^[0-9a-f]{64}$/.test(reference)) throw new Error('keyFor produced a malformed key');
  const ops = 20_000;
  const started = process.hrtime.bigint();
  for (let i = 0; i < ops; i++) keyFor(input);
  const elapsedNs = Number(process.hrtime.bigint() - started);
  return { ops, nsPerOp: elapsedNs / ops, opsPerSec: 1e9 / (elapsedNs / ops), reference };
}

// ---------------------------------------------------------------------------
// 运行 + 报告
// ---------------------------------------------------------------------------

const fmtMs = (v) => `${v.toFixed(3)} ms`;
const BUDGETS = {
  cacheHit: 50,
  single: 1500,
  fusion: 8000,
  fetchT1: 5000,
};

async function main() {
  const cacheHit = await benchCacheHit();
  const single = await benchSingleEngine();
  const fusion = await benchFusion();
  const fetchT1 = await benchFetchT1();
  const keyBench = benchKeyFor();

  const rows = [
    { name: 'L0 缓存命中（search 全管线同键重放）', ...cacheHit, budget: `<${BUDGETS.cacheHit} ms` },
    { name: '免费池单引擎直出（free×1，miss 热路径）', ...single, budget: `p95≤${BUDGETS.single / 1000} s` },
    { name: '双引擎 RRF 融合（free×2）', ...fusion, budget: `p95≤${BUDGETS.fusion / 1000} s` },
    { name: 'fetchPipeline T1（静态抓取+抽取）', ...fetchT1, budget: `p95≤${BUDGETS.fetchT1 / 1000} s` },
  ];
  const verdicts = [
    cacheHit.max < BUDGETS.cacheHit,
    single.p95 <= BUDGETS.single,
    fusion.p95 <= BUDGETS.fusion,
    fetchT1.p95 <= BUDGETS.fetchT1,
  ];

  // ---- stdout 表格 ----
  const envLine = `node ${process.version} · ${os.platform()} ${os.arch()} · ${
    (os.cpus()[0]?.model ?? 'unknown cpu').trim()
  }`;
  console.log(`WebStack pipeline benchmark — seed=${SEED} — ${envLine}`);
  console.log('（全离线确定性 fixture；数值为本机计时，跨机器仅可比量级）');
  console.log('');
  const cols = ['scenario', 'n', 'p50', 'p95', 'mean', 'max', 'budget', 'verdict'];
  const table = rows.map((row, i) => ({
    scenario: row.name,
    n: String(row.n),
    p50: fmtMs(row.p50),
    p95: fmtMs(row.p95),
    mean: fmtMs(row.mean),
    max: fmtMs(row.max),
    budget: row.budget,
    verdict: verdicts[i] ? 'PASS' : 'FAIL',
  }));
  table.push({
    scenario: '缓存键指纹 keyFor 微基准',
    n: String(keyBench.ops),
    p50: '—',
    p95: `${keyBench.nsPerOp.toFixed(0)} ns/op`,
    mean: `${(keyBench.opsPerSec / 1e6).toFixed(1)} M ops/s`,
    max: '—',
    budget: '信息项',
    verdict: '—',
  });
  const width = {};
  for (const col of cols) width[col] = Math.max(col.length, ...table.map((r) => r[col].length));
  const line = (cells) => cells.map((c) => c.padEnd(width[c])).join('  ');
  console.log(line(cols));
  console.log(cols.map((c) => '-'.repeat(width[c])).join('  '));
  for (const row of table) console.log(line(cols.map((c) => row[c])));
  console.log('');
  console.log(`预算判定：${verdicts.every(Boolean) ? '全部达标' : '存在未达标项'}`);

  // ---- docs/BENCHMARK.md ----
  const mdTable = (header, body) =>
    [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...body.map((row) => `| ${row.join(' | ')} |`),
    ].join('\n');

  const markdown = `# BENCHMARK — 全管线性能基准

- 生成方式：\`pnpm --filter dsh-webstack bench\`（离线确定性 fixture，seed=${SEED}；
  node 直接运行，不进 vitest/check 链）。
- 运行环境：${envLine}
- 口径：最近邻秩百分位；搜索场景经 \`WebstackAggregator.search/searchHits\`
  全管线（hints→分档→计划→凭据快照→指纹→缓存→fallback/融合→seam 映射），
  每次场景前有 20 次预热不计样本；数据集逐字节可复现，计时为当次机器实测。

## 结果

${mdTable(
  ['场景', 'n', 'p50', 'p95', 'mean', 'max'],
  rows.map((r) => [
    r.name,
    String(r.n),
    fmtMs(r.p50),
    fmtMs(r.p95),
    fmtMs(r.mean),
    fmtMs(r.max),
  ]),
)}

缓存键指纹微基准：${keyBench.ops.toLocaleString('en-US')} 次 \`keyFor\`
（canonical JSON → sha256，双引擎维度输入）平均
**${keyBench.nsPerOp.toFixed(0)} ns/op ≈ ${(keyBench.opsPerSec / 1e6).toFixed(1)} M ops/s**
（参考键 \`${keyBench.reference.slice(0, 16)}…\`）。指纹成本相对网络预算可忽略，
不设达标线（信息项）。

## 预算对照

${mdTable(
  ['预算项', '阈值', '实测', '判定'],
  [
    ['L0 缓存命中（全管线）', '<50 ms', `max ${fmtMs(cacheHit.max)}（n=${cacheHit.n}）`, verdicts[0] ? '达标 ✓' : '未达标 ✗'],
    ['免费池单引擎直出（热路径）', '≤1.5 s', `p95 ${fmtMs(single.p95)}`, verdicts[1] ? '达标 ✓' : '未达标 ✗'],
    ['双引擎融合', '≤8 s', `p95 ${fmtMs(fusion.p95)}`, verdicts[2] ? '达标 ✓' : '未达标 ✗'],
    ['抓取 T1（静态管线）', '≤5 s', `p95 ${fmtMs(fetchT1.p95)}`, verdicts[3] ? '达标 ✓' : '未达标 ✗'],
  ],
)}

**结论：${verdicts.every(Boolean) ? '全部场景达预算。' : '存在未达标场景——先查环境噪声再回归。'}**

## 方法说明

- **假 outbound**：\`bench/outbound-mock.loader.mjs\` 经 \`module.register\` 把
  \`src/safety/outbound.ts\` 替换为内存即回合的替身（~22 KB 确定性 HTML），
  fetchPipeline T1 腿零网络完成；搜索腿用脚本化假引擎（BaseEngine 包装，
  attempts/provenance 语义与真实适配器一致），同样零网络。
- **确定性**：查询词、命中 URL、页面内容全部由 mulberry32(${SEED}) 派生；
  单引擎/融合场景每循环换查询键以强制缓存 miss（测的是 miss 热路径），
  缓存命中场景则固定同键重放。
- **与 check 铁律的关系**：本目录不在 tsc/vitest/biome/tsdown 扫描范围内，
  基准代码的改动不影响 \`pnpm -r run check && pnpm lint\`。
`;

  await writeFile(path.resolve(HERE, '../docs/BENCHMARK.md'), markdown, 'utf8');
  console.log('written: docs/BENCHMARK.md');
}

main().catch((error) => {
  console.error('benchmark failed:', error);
  process.exitCode = 1;
});
