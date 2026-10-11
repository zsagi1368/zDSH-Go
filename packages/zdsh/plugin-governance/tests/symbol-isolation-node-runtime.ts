/**
 * 面 2 载体（TC-B4-G1 A-1.2.2「发布安装 node 运行时」面）——非 vitest spec。
 *
 * 由 symbol-isolation.spec.ts 经 tsx spawn：cwd=隔离空目录（无 tsconfig）+ `--tsconfig`
 * 空配置覆写 + NODE_PATH=''——无 vitest/tsconfig-paths 解析门面，裸 node ESM 解析语义
 * （R3-13「发布安装运行时」实测形；前代理回执 §2 裸 node 面实测：源码 .ts 直接 node 跑
 * =ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX → 载体=tsx）。
 *
 * legs（argv[2]）+ 配置 JSON（argv[3]，形如 {"ids":[...]}）：
 * - `release-fixture`：DSH_HOME=profiles 仿形（dsh-guard test/run.mjs T7 面2 同源共享
 *   设计）→ 出厂集 id 全绿（junction→官方层单一目标不误杀）。
 * - `repo-tree`：DSH_HOME=repoRoot → 八件 id 各自 reset 后真扫描全绿（K-1.2.1 面2腿）。
 * - `dual-red`：DSH_HOME=双副本底稿（T6 面A 同源）→ 必红（面2检查活体、非空绿对照）。
 * - `self-name`：裸自名 `import('@deepseek-ai/dsh-plugin-governance')` 解析面实测
 *   （R3-13 销项核心）：exports 自引用 → lib/index.js。三态诚实上报：
 *   `green`（lib 含 G1 实现且检查全绿）/ `stale-lib`（解析成功=解析面成立，但 lib 为
 *   旧构建=构建产物滞后，非检查失败）/ `unresolved`（解析失败=R3-13 翻转坐实，父 spec 判红）。
 *
 * stdout 末行 = `G1-FACE2-REPORT <json>`；断言语义全部归父 spec（本载体只诚实上报）。
 */

import {
  LoadGuard as SrcLoadGuard,
  getSymbolIsolationScanStats as srcStats,
  resetSymbolIsolationCacheForTest as srcReset,
} from '../src/guards/load-guard.ts'
import { testManifest } from './fixtures.ts'
import type { Plugin } from '../src/spec/index.ts'

interface PreLoadFailure {
  check: string
  message: string
  severity: string
}

interface PreLoadWarning {
  check: string
  message: string
}

interface PreLoadResult {
  allowed: boolean
  failures: PreLoadFailure[]
  warnings: PreLoadWarning[]
}

interface GuardLike {
  preLoad(plugin: Plugin, kernelVersion: string): Promise<PreLoadResult>
}

interface StatsLike {
  scans: number
  cacheHits: number
}

interface LegConfig {
  ids: string[]
}

interface LegRunReport {
  id: string
  allowed: boolean
  symMessages: string[]
  scans: number
  cacheHits: number
}

/** 构造仅含清单的双插件（五连检其余四检全绿的最小合法清单，来自共享 fixtures）。 */
function pluginFor(id: string): Plugin {
  return { manifest: testManifest({ id }), install(): void {} }
}

async function runOne(
  guard: GuardLike,
  id: string,
  reset: () => void,
  stats: () => StatsLike,
): Promise<LegRunReport> {
  reset()
  const before = stats()
  const result = await guard.preLoad(pluginFor(id), '0.2.0-rc.2')
  const after = stats()
  return {
    id,
    allowed: result.allowed,
    symMessages: result.failures.filter(f => f.message.startsWith('symbol-isolation')).map(f => f.message),
    scans: after.scans - before.scans,
    cacheHits: after.cacheHits - before.cacheHits,
  }
}

async function main(): Promise<void> {
  const leg = process.argv[2] ?? ''
  const config = JSON.parse(process.argv[3] ?? '{"ids":[]}') as LegConfig
  const results: LegRunReport[] = []
  let selfName: Record<string, unknown> | undefined

  if (leg === 'self-name') {
    try {
      const mod = (await import('@deepseek-ai/dsh-plugin-governance')) as Record<string, unknown>
      const hasGuard = typeof mod.LoadGuard === 'function'
      const hasImplementation =
        typeof mod.getSymbolIsolationScanStats === 'function' &&
        typeof mod.resetSymbolIsolationCacheForTest === 'function'
      selfName = { resolved: true, hasLoadGuard: hasGuard, hasImplementation }
      if (hasGuard && hasImplementation) {
        selfName.mode = 'green'
        selfName.run = await runOne(
          new (mod.LoadGuard as new () => GuardLike)(),
          config.ids[0] ?? 'core/webstack',
          mod.resetSymbolIsolationCacheForTest as () => void,
          mod.getSymbolIsolationScanStats as () => StatsLike,
        )
      } else {
        selfName.mode = 'stale-lib'
      }
    } catch (error) {
      selfName = { resolved: false, mode: 'unresolved', error: String(error).slice(0, 500) }
    }
  } else {
    for (const id of config.ids) {
      results.push(await runOne(new SrcLoadGuard(), id, srcReset, srcStats))
    }
  }

  const report = {
    leg,
    node: process.version,
    cwd: process.cwd(),
    dshHome: process.env.DSH_HOME ?? null,
    dshBranchHome: process.env.DSH_BRANCH_HOME ?? null,
    results,
    selfName,
  }
  console.log(`G1-FACE2-REPORT ${JSON.stringify(report)}`)
}

main().then(
  () => {},
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)
