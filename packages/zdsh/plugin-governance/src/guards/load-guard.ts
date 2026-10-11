/**
 * LoadGuard - 加载守卫
 *
 * 在插件加载前进行预检查，确保插件安全性和兼容性。
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Plugin, LoadResult } from '../spec/index.js'
import type { PluginSandboxConfig, CapabilityDeclaration } from '../spec/index.js'
import { resolveBranchStorageRoot } from '../persistence/plugin-persistence.js'
import { semverCompare } from '../semver.js'

/**
 * 预检查看到的清单形状：字段可能缺失或畸形（这正是检查要拦截的），
 * 因此以宽松类型读取，避免"类型系统证明不可达"的防御分支被误判。
 */
type LooseManifest = Partial<Plugin['manifest']>

interface PreLoadCheck {
  name: string
  run(plugin: Plugin, kernelVersion: string): CheckResult
}

interface CheckResult {
  passed: boolean
  severity?: 'error' | 'warning' | undefined
  message?: string | undefined
}

class CheckPassed implements CheckResult {
  constructor(public message?: string) {}
  passed = true
}

class CheckFailed implements CheckResult {
  constructor(
    public message: string,
    public severity: 'error' | 'warning' = 'error',
  ) {}
  passed = false
}

/**
 * LoadGuard - 加载守卫
 *
 * 在插件加载前按注册顺序执行一组预检查（清单完整性、版本兼容、
 * 沙箱配置、能力声明、符号隔离），返回聚合的加载结果。
 */
export class LoadGuard {
  private checks: PreLoadCheck[] = [
    new ManifestIntegrityCheck(),
    new VersionCompatibilityCheck(),
    new SandboxConfigCheck(),
    new CapabilityValidityCheck(),
    new SymbolIsolationCheck(),
  ]

  /**
   * 执行全部预检查
   * @param plugin - 待加载的插件。
   * @param kernelVersion - 当前内核版本，用于版本兼容检查。
   * @returns 聚合的加载结果（allowed/failures/warnings）。
   */
  preLoad(plugin: Plugin, kernelVersion: string): Promise<LoadResult> {
    const results = this.checks.map(check => check.run(plugin, kernelVersion))

    const failures = results.filter(r => !r.passed).map(r => ({
      check: r.message?.split(':')[0] || 'unknown',
      message: r.message || 'Unknown error',
      severity: r.severity || 'error',
    }))

    const warnings = results
      .filter(r => !r.passed && r.severity === 'warning')
      .map(r => ({
        check: r.message?.split(':')[0] || 'unknown',
        message: r.message || 'Unknown warning',
      }))

    return Promise.resolve({
      allowed: failures.filter(f => f.severity === 'error').length === 0,
      failures,
      warnings,
    })
  }
}

class ManifestIntegrityCheck implements PreLoadCheck {
  name = 'manifest-integrity'

  run(plugin: Plugin): CheckResult {
    const manifest = plugin.manifest as LooseManifest

    if (!manifest.id) {
      return new CheckFailed('Plugin manifest missing required field: id')
    }
    if (!manifest.version) {
      return new CheckFailed('Plugin manifest missing required field: version')
    }
    if (!manifest.name) {
      return new CheckFailed('Plugin manifest missing required field: name')
    }
    if (!manifest.dsh?.compatible) {
      return new CheckFailed('Plugin manifest missing required field: dsh.compatible')
    }
    if (!manifest.capabilities?.length) {
      return new CheckFailed('Plugin manifest missing required field: capabilities')
    }
    if (!manifest.sandbox) {
      return new CheckFailed('Plugin manifest missing required field: sandbox')
    }

    return new CheckPassed()
  }
}

class VersionCompatibilityCheck implements PreLoadCheck {
  name = 'version-compatibility'

  run(plugin: Plugin, kernelVersion: string): CheckResult {
    const compatible = (plugin.manifest as LooseManifest).dsh?.compatible || ''

    // 版本检查走共享 semver 比较（semver.ts），杜绝字典序误判
    // （如 '0.9.0' >= '0.10.0' 在字符串比较下为真）。
    if (compatible.includes('<')) {
      const maxVersion = compatible.split('<')[1]?.trim()
      if (maxVersion && semverCompare(kernelVersion, maxVersion) >= 0) {
        return new CheckFailed(
          `Plugin requires DSH < ${maxVersion}, but running ${kernelVersion}`,
          'error',
        )
      }
    }

    if (compatible.includes('>=')) {
      const minVersion = compatible.split('>=')[1]?.split(' ')[0]
      if (minVersion && semverCompare(kernelVersion, minVersion) < 0) {
        return new CheckFailed(
          `Plugin requires DSH >= ${minVersion}, but running ${kernelVersion}`,
          'error',
        )
      }
    }

    return new CheckPassed()
  }
}

class SandboxConfigCheck implements PreLoadCheck {
  name = 'sandbox-config'

  run(plugin: Plugin): CheckResult {
    const sandbox = (plugin.manifest as LooseManifest).sandbox as
      | Partial<PluginSandboxConfig>
      | undefined

    if (!sandbox) {
      return new CheckFailed('Plugin manifest missing required field: sandbox')
    }

    if (!sandbox.type) {
      return new CheckFailed('Sandbox config missing required field: type')
    }

    if (!['process', 'worker', 'inline'].includes(sandbox.type)) {
      return new CheckFailed(
        `Invalid sandbox type: ${sandbox.type}. Must be one of: process, worker, inline`,
        'error',
      )
    }

    if (!sandbox.resources) {
      return new CheckFailed('Sandbox config missing required field: resources')
    }

    if (sandbox.resources.memoryLimitMb <= 0) {
      return new CheckFailed('Memory limit must be positive', 'error')
    }

    if (sandbox.resources.timeoutMs <= 0) {
      return new CheckFailed('Timeout must be positive', 'error')
    }

    return new CheckPassed()
  }
}

class CapabilityValidityCheck implements PreLoadCheck {
  name = 'capability-validity'

  run(plugin: Plugin): CheckResult {
    const capabilities = ((plugin.manifest as LooseManifest).capabilities ??
      []) as Array<Partial<CapabilityDeclaration>>

    for (const cap of capabilities) {
      if (!cap.type) {
        return new CheckFailed('Capability missing required field: type', 'error')
      }

      const validTypes = ['tool', 'hook', 'service', 'event', 'ui-slot', 'llm-adapter']
      if (!validTypes.includes(cap.type)) {
        return new CheckFailed(
          `Invalid capability type: ${cap.type}. Must be one of: ${validTypes.join(', ')}`,
          'error',
        )
      }

      // 根据类型验证特定字段
      if (cap.type === 'tool' && !cap.tool?.name) {
        return new CheckFailed('Tool capability missing required field: name', 'error')
      }
      if (cap.type === 'hook' && !cap.hook?.event) {
        return new CheckFailed('Hook capability missing required field: event', 'error')
      }
      if (cap.type === 'service' && !cap.service?.factory) {
        return new CheckFailed('Service capability missing required field: factory', 'error')
      }
    }

    return new CheckPassed()
  }
}

/**
 * SymbolIsolationCheck — 符号隔离检查（TC-B4-G1，案 i：检查语义进内核；
 * 修复语义带外=dsh-guard CLI，K-1.2.2 采纳——本检查只判定+引导，零修复动作）。
 *
 * 结束恒过桩：对「junction 被 pnpm/npm 重排成真实目录 → 双物理副本 →
 * 模块级 Symbol 隔离崩（scheduler.prepare 崩溃族）」形态返回 CheckFailed（R-1.2.1）。
 *
 * 双作用面声明（注释级预留、零机制——B.3 防误接条款 2 硬边界）：
 * - 作用面①（今日生效）：PreLoad 链（本文件链位数组末位）——经治理守卫装载的插件路径。
 * - 作用面②（预留、不接线）：出厂预装 mount 走 cordis `ctx.loader.create` 原始装载通道
 *   （preinstaller.ts:32 头注「mount path rides the raw cordis ctx.loader.create」=边界源码自证），
 *   不经本链——mount 隔离契约=执行器 per-item fail-open+台账 mount 列（DESIGN:486-487），
 *   与本检查位解耦，**不得声称 factory mount 因此获得符号隔离防护**（B.3 条款 1）。
 *   若欲令预装 mount 亦过符号隔离检，须经「governed mount」把 loader.create 包进治理守卫链
 *   ——范围外登记项（DESIGN:488/:523/:601），批次 4.2 之后独立裁决，本卡零机制实现（条款 2）。
 *
 * 判据（DESIGN §2.3，参数化 hostRoot+governanceStorageRoot 双扫描面）：
 * - 判据 1【必装】：宿主树 node_modules/@deepseek-ai/* 与 .pnpm store 同作用域包
 *   >1 可解析真实实例（symlink 链终点目录 hash 不同）→ 双副本候选。
 * - 判据 2【必装】：出厂插件 bundle 产物内嵌核心符号（dist/lib 运行时字面 import
 *   外置清单核对，防 bundled-cordis 自拷贝）。
 * - 判据 3【防御深度级】：治理存储区 installed/**\/node_modules/@deepseek-ai/** 真实目录副本。
 *   U1 降级注记（卡面必录）：R2 U1 已销（TC-B0 探针三值=不复现，根因=npm 安装通道无
 *   importer 的结构事实，sandbox-b0/ 底稿 12 件在案）→ 今日可达面为零；实现保留
 *   （只读扫描零误杀面）以预防未来接线变更（governed mount/存储区 importer 类）静默复活触发面。
 *
 * 语义保真（dsh-guard.mjs 只读参照，本体不进树——内核零新增依赖，纯 node:fs/path 内建）：
 * - junction/symlink 单一目标=正常（原件 isSymlink continue 判据 :110-112/:129-143；
 *   本实现以 Dirent.isSymbolicLink()〔lstat 语义，不跟随〕+ realpath 终点去重同形兑现）。
 * - 检查只读：全部扫描面零写入。
 * - fail-closed：检查自身异常 → CheckFailed 拒绝加载，绝不放行（A-1.2.3，对齐原件语义与北极星 4）。
 * - detail 含路径清单可查询：CheckFailed.message 逐条携带判据标记+涉险路径（CheckResult
 *   类型面不变=CE-4，message 即 detail 载体）。
 *
 * 性能（§2.3）：pass 结果按 (hostRoot, mtime) 模块级缓存——PreLoad 每插件不重复扫盘。
 * 缓存键 mtime 可伪造性=D1 深审已登记面（G1 卡面登记+D1b FB2 统一定级 [建议]）。
 * FB2 加固在位（TC-B4-H1 面一，D1b §3-FB2 加固建议①③）：①缓存键含
 * installed/<ns> 命名空间粒度 mtime 腿（封「既有 ns 下新增插件目录而 installed/
 * 顶层 mtime 不动」的事故性 staleness 窗=D1b 幕 b 实证面）；③pass 缓存条目带
 * 命中代数上限，满即强制真重扫（把对抗性 mtime 伪造的恒过窗压缩为有界代数）。
 * 加固≠消除（措辞纪律零夸大）：对宿主树持 FS 写权的对抗者仍可逐代恢复 mtime
 * ——其位阶已越过本检查防护位阶（目标威胁=pnpm/npm 布局事故非对抗者，D1b FB2
 * 定级依据原文不变）；签名加固维持不做（G1 卡面 :259-260 登记语义一致）。
 */
class SymbolIsolationCheck implements PreLoadCheck {
  name = 'symbol-isolation'

  run(plugin: Plugin): CheckResult {
    try {
      const hostRoot = defaultHostRoot()
      const storageRoot = resolveBranchStorageRoot()
      const cacheKey = symbolIsolationCacheKey(hostRoot, storageRoot)
      const cached = passCache.get(cacheKey)
      if (cached !== undefined) {
        if (cached.hits < PASS_CACHE_MAX_HITS) {
          cached.hits += 1
          cacheHits += 1
          return cached.result
        }
        // FB2 ③代数上限：满 N 代命中强制一次真重扫（对抗性伪造窗有界化；
        // 清洁树下重扫结果不变=仅性能契约的摊销放宽，scans 语义诚实计数）。
        passCache.delete(cacheKey)
      }
      scanRuns += 1
      const findings: string[] = []
      collectDualInstanceFindings(hostRoot, findings)
      collectEmbeddedCoreFindings(hostRoot, storageRoot, plugin, findings)
      collectStorageCopyFindings(storageRoot, findings)
      if (findings.length > 0) {
        return new CheckFailed(
          ['symbol-isolation: 检出双副本/内嵌核心符号（模块级 Symbol 隔离风险），拒绝加载']
            .concat(findings, REMEDIATION_HINT)
            .join('\n'),
          'error',
        )
      }
      const passed = new CheckPassed('symbol-isolation: 宿主树+治理存储区双扫描面清洁')
      passCache.set(cacheKey, { result: passed, hits: 0 })
      return passed
    } catch (error) {
      // fail-closed（A-1.2.3）：扫描面任何异常都拒绝加载而非放行/逃逸。
      const detail = error instanceof Error ? error.message : String(error)
      return new CheckFailed(`symbol-isolation: 检查自身异常，fail-closed 拒绝加载: ${detail}`, 'error')
    }
  }
}

/* ------------------------------------------------------------------ *
 * SymbolIsolationCheck 私有辅助（模块级，不导出——观测面两函数除外）
 * ------------------------------------------------------------------ */

/** 受检核心作用域：@deepseek-ai 全部包（通配作用域、不限固定清单——与带外 walkForCoreCopies 同形）。 */
const CORE_SCOPE = '@deepseek-ai'

/** pnpm store 内作用域包条目名前缀（@deepseek-ai+<pkg>@<ver> 命名式）。 */
const CORE_SCOPE_STORE_PREFIX = `${CORE_SCOPE}+`

/** 出厂 bundle 区（W2/W3 整树入库事实布局；zdsh-factory/seed.json source 字段同根）。 */
const FACTORY_BUNDLE_NM = join('packages', 'zdsh', 'factory-bundle', 'node_modules')

/** DSH profiles 形（发布安装运行时）：官方层=profiles/node_modules，profile 层=profiles/<name>/node_modules。 */
const PROFILES_DIR_NAME = 'profiles'

/** 带外自家备份区目录名——不回扫（幂等，dsh-guard walkForCoreCopies 同形）。 */
const GUARD_BACKUP_DIR_NAME = '.dsh-guard-backup'

/** bundle 产物目录名（判据 2 扫描面）。 */
const BUNDLE_DIR_NAMES = ['dist', 'lib'] as const

/** bundle 运行时文件后缀（.d.ts/.map 等非运行时面自然排除）。 */
const BUNDLE_FILE_PATTERN = /\.(?:js|mjs|cjs)$/

/**
 * 证据 E1：bundler 内联源路径痕迹。真拷贝入 bundle 时产物携带
 * node_modules/@deepseek-ai/… 模块路径注记；外置字面 import（from"@deepseek-ai/…"）不含此形，永不命中。
 */
const INLINED_CORE_PATH_PATTERN = /node_modules[\/\\]@deepseek-ai[\/\\]/

/**
 * 证据 E2：cordis 运行时注册键指纹。vendor/cordis/lib/index.js 实测携带 18 枚
 * Symbol.for("cordis.*") 注册键（内嵌拷贝必携带其子集）；阈值 3=捆绑拷贝全键在身，
 * 而 interop 探针仅触 1-2 键不构成拷贝。K-1.2.1 校准：出厂八件 13 个 bundle 目录
 * 49 个运行时文件（2.5MB）E1/E2 双双零命中（O3 卡重测）。
 */
const CORDIS_RUNTIME_KEY_PATTERN = /Symbol\.for\(\s*["'](cordis\.[A-Za-z0-9_]+)["']\s*\)/g
const CORDIS_EMBED_KEY_THRESHOLD = 3

/** 治理台账 id → installed/<ns>/<name> 两级权威布局（plugin-governance-host npmInstallDir 同形）。 */
const INSTALLED_ID_PATTERN = /^([^/]+)\/([^/]+)$/

/**
 * K-1.2.2 引导文案（修复动作不进内核——内核只判定+引导）：
 * detail 指回 dsh-guard CLI 与 safe-change 备份规程。
 */
const REMEDIATION_HINT = [
  '修复引导（K-1.2.2：内核只判定不修复，修复语义在带外 dsh-guard CLI）:',
  '  1) 诊断: node dsh-guard.mjs check [--profile <name>]（只读体检，输出偏差与路径清单）',
  '  2) 修复: node dsh-guard.mjs fix（真实副本改名备份移出+junction 重建；存储区副本移出同备份纪律）',
  '  3) 一切修复动作须遵循 safe-change 备份规程：先备份后改动，备份区删除权永久归用户。',
].join('\n')

/** pass 结果模块级缓存（§2.3 性能契约）；仅缓存 pass——fail 结果每次重扫（红线不粘滞）。
 * FB2 ③：条目携带命中代数（hits），满 PASS_CACHE_MAX_HITS 即删键强制真重扫。 */
const PASS_CACHE_MAX_HITS = 64
const passCache = new Map<string, { result: CheckPassed; hits: number }>()
let scanRuns = 0
let cacheHits = 0

/**
 * 观测面（验收 7 性能断言载体）：扫描/缓存命中计数只读快照。
 * @returns the scan and cache-hit counters since process start.
 */
export function getSymbolIsolationScanStats(): { scans: number; cacheHits: number } {
  return { scans: scanRuns, cacheHits }
}

/** 测试面：清空 pass 缓存与计数（模块级单例；vitest forks 池下 spec 文件间天然隔离）。 */
export function resetSymbolIsolationCacheForTest(): void {
  passCache.clear()
  scanRuns = 0
  cacheHits = 0
}

/**
 * 默认宿主根：DSH_HOME（设置且非空白，发布安装 profiles 形入口）→ process.cwd()
 * （树内开发/打包宿主=仓库根形）。不做 homedir 兜底（区别于带外 findDshHome——
 * 内核检查在宿主进程内运行，cwd 即宿主树；兜底会把用户主目录状态引入检查面，破坏密闭性）。
 */
function defaultHostRoot(): string {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return resolve(fromEnv)
  }
  return process.cwd()
}

/** (hostRoot, mtime) 缓存键：mtime 签名=三个扫描根目录 mtimeMs（装/卸/增删即变，缓存失效重扫）
 * + FB2 ① installed/<ns> 命名空间粒度腿（封 D1b 幕 b：既有 ns 下新增插件目录时
 * installed/ 顶层 mtime 不动、旧键面失明的事故性 staleness 窗）。 */
function symbolIsolationCacheKey(hostRoot: string, storageRoot: string): string {
  return [hostRoot, storageRoot, scanRootMtimes(hostRoot, storageRoot)].join('|')
}

function scanRootMtimes(hostRoot: string, storageRoot: string): string {
  const installedRoot = join(storageRoot, 'installed')
  return [
    dirMtimeOrZero(join(hostRoot, 'node_modules')),
    dirMtimeOrZero(join(hostRoot, FACTORY_BUNDLE_NM)),
    dirMtimeOrZero(installedRoot),
    installedNsMtimes(installedRoot),
  ].join(',')
}

/**
 * installed/<ns> 各命名空间目录的 mtime 签名（name=mtimeMs 升序拼接）。仅真实
 * 目录入键——junction/symlink 形 ns 条目跳过（保守方向：不入键=其变动不触发
 * 失效，与判据3「链接不跟随」同形自洽）。缺席/不可读=空签名（缺席即正常，
 * dirMtimeOrZero 同哲学；A-1.2.3 注入面由主扫描体的 fail-closed 承载，本
 * 签名腿自吞异常绝不改变检查判定方向）。
 */
function installedNsMtimes(installedRoot: string): string {
  try {
    const parts: string[] = []
    for (const entry of readdirSync(installedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      parts.push(`${entry.name}=${dirMtimeOrZero(join(installedRoot, entry.name))}`)
    }
    return parts.sort().join(';')
  } catch {
    return ''
  }
}

function dirMtimeOrZero(dirPath: string): number {
  try {
    return statSync(dirPath).mtimeMs
  } catch {
    return 0
  }
}

/** statSync 跟随语义的目录判定（缺席/文件/异常=false=「缺席即正常」扫描面跳过形）。 */
function isDirSafe(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory()
  } catch {
    return false
  }
}

/** realpath 终点解析（悬空链接/竞态消失=null=「可解析真实实例」语义下跳过不计）。 */
function safeRealpath(targetPath: string): string | null {
  try {
    return realpathSync(targetPath)
  } catch {
    return null
  }
}

/**
 * 判据 1：宿主树内 @deepseek-ai 作用域包按 realpath 终点池化全部可解析视图，
 * 同一包名 >1 个 distinct 真实实例（链终点目录 hash 不同）=双副本候选。
 * junction/symlink 单一目标（多视图同终点）=正常，天然被去重（原件语义保真）。
 */
function collectDualInstanceFindings(hostRoot: string, findings: string[]): void {
  const pool = new Map<string, Map<string, string[]>>()
  for (const nmRoot of hostNodeModulesRoots(hostRoot)) {
    addScopeViews(join(nmRoot, CORE_SCOPE), pool)
    addPnpmStoreViews(nmRoot, pool)
  }
  for (const [pkg, instances] of pool) {
    if (instances.size > 1) {
      const lines: string[] = [
        `[判据1·双副本候选] ${CORE_SCOPE}/${pkg}: ${String(instances.size)} 个可解析真实实例（symlink 链终点目录 hash 不同）`,
      ]
      for (const [realPath, views] of instances) {
        lines.push(`    实例 ${realPath}（视图: ${views.join(' ; ')}）`)
      }
      findings.push(lines.join('\n'))
    }
  }
}

/**
 * 宿主树扫描根集合：host 根 node_modules + DSH profiles 形（官方层+各 profile 层）
 * + 出厂 bundle 区 node_modules。深层 per-package 视图（apps/*、.pnpm/<consumer> 内部）
 * 不入池：pnpm 内部多版本属布局常态、非宿主运行时解析面，入池即 K-1.2.1 误杀源。
 */
function hostNodeModulesRoots(hostRoot: string): string[] {
  const roots = [join(hostRoot, 'node_modules')]
  const profilesRoot = join(hostRoot, PROFILES_DIR_NAME)
  if (isDirSafe(profilesRoot)) {
    roots.push(join(profilesRoot, 'node_modules'))
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        roots.push(join(profilesRoot, entry.name, 'node_modules'))
      }
    }
  }
  const factoryNm = join(hostRoot, FACTORY_BUNDLE_NM)
  if (isDirSafe(factoryNm)) {
    roots.push(factoryNm)
  }
  return roots
}

/** .pnpm store 视图：hoisted 层（.pnpm/node_modules/@deepseek-ai）+ 作用域 store 条目（@deepseek-ai+*）。 */
function addPnpmStoreViews(nmRoot: string, pool: Map<string, Map<string, string[]>>): void {
  const pnpmRoot = join(nmRoot, '.pnpm')
  if (!isDirSafe(pnpmRoot)) {
    return
  }
  addScopeViews(join(pnpmRoot, 'node_modules', CORE_SCOPE), pool)
  for (const entryName of readdirSync(pnpmRoot)) {
    if (!entryName.startsWith(CORE_SCOPE_STORE_PREFIX)) {
      continue
    }
    addScopeViews(join(pnpmRoot, entryName, 'node_modules', CORE_SCOPE), pool)
  }
}

/** 单个作用域目录视图入池：realpath 终点为实例键、视图路径留证（detail 路径清单可查询）。 */
function addScopeViews(scopeDir: string, pool: Map<string, Map<string, string[]>>): void {
  if (!isDirSafe(scopeDir)) {
    return
  }
  for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue // 作用域目录内的散文件（锁文件等）非包视图
    }
    const viewPath = join(scopeDir, entry.name)
    const realPath = safeRealpath(viewPath)
    if (realPath === null || !isDirSafe(realPath)) {
      continue // 悬空链接=不可解析；终点非目录=非包实例——「可解析真实实例」语义下均跳过
    }
    const instances = pool.get(entry.name)
    if (instances === undefined) {
      pool.set(entry.name, new Map([[realPath, [viewPath]]]))
      continue
    }
    const views = instances.get(realPath)
    if (views === undefined) {
      instances.set(realPath, [viewPath])
    } else {
      views.push(viewPath)
    }
  }
}

/**
 * 判据 2：出厂插件 bundle 产物内嵌核心符号（防 bundled-cordis 自拷贝）。
 * 扫描面 (a) 出厂 bundle 区各工件（含 monorepo 形 packages/*——webstack 三兄弟实测布局）；
 * (b) 该插件的治理存储区安装树 installed/<ns>/<name>。
 * 外置清单核对语义：运行时字面 import（外置形，宿主解析）永不标；内嵌=证据 E1/E2 命中。
 */
function collectEmbeddedCoreFindings(
  hostRoot: string,
  storageRoot: string,
  plugin: Plugin,
  findings: string[],
): void {
  const factoryNm = join(hostRoot, FACTORY_BUNDLE_NM)
  if (isDirSafe(factoryNm)) {
    for (const entry of readdirSync(factoryNm, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue
      }
      const artifactRoot = join(factoryNm, entry.name)
      if (!existsSync(join(artifactRoot, 'package.json'))) {
        continue // .bin/作用域目录等非工件条目
      }
      scanBundleRoot(artifactRoot, findings)
    }
  }
  const pluginId = (plugin.manifest as LooseManifest).id
  const installedId = typeof pluginId === 'string' ? INSTALLED_ID_PATTERN.exec(pluginId.replace(/^@/, '')) : null
  if (installedId !== null) {
    const installedDir = join(storageRoot, 'installed', String(installedId[1]), String(installedId[2]))
    if (isDirSafe(installedDir)) {
      scanBundleRoot(installedDir, findings)
    }
  }
}

/** 单工件 bundle 面：根级 dist/lib + monorepo 形 packages/*\/{dist,lib}（一层为限）。 */
function scanBundleRoot(artifactRoot: string, findings: string[]): void {
  for (const dirName of BUNDLE_DIR_NAMES) {
    scanBundleDir(join(artifactRoot, dirName), findings)
  }
  const packagesRoot = join(artifactRoot, 'packages')
  if (isDirSafe(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue
      }
      for (const dirName of BUNDLE_DIR_NAMES) {
        scanBundleDir(join(packagesRoot, entry.name, dirName), findings)
      }
    }
  }
}

/** bundle 目录递归扫（chunk 子目录在面内；只读，.d.ts/.map 等非运行时后缀自然排除）。 */
function scanBundleDir(bundleDir: string, findings: string[]): void {
  if (!isDirSafe(bundleDir)) {
    return
  }
  for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
    const entryPath = join(bundleDir, entry.name)
    if (entry.isDirectory()) {
      scanBundleDir(entryPath, findings)
      continue
    }
    if (!BUNDLE_FILE_PATTERN.test(entry.name)) {
      continue
    }
    scanBundleFile(entryPath, findings)
  }
}

/** 单文件双证据核对：E1 内联路径痕迹 / E2 cordis 注册键指纹（≥阈值=内嵌运行时）。 */
function scanBundleFile(filePath: string, findings: string[]): void {
  const content = readFileSync(filePath, 'utf8')
  const evidence: string[] = []
  if (INLINED_CORE_PATH_PATTERN.test(content)) {
    evidence.push('E1 内联源路径痕迹(node_modules/@deepseek-ai/…)')
  }
  const cordisKeys = new Set<string>()
  for (const match of content.matchAll(CORDIS_RUNTIME_KEY_PATTERN)) {
    cordisKeys.add(String(match[1]))
  }
  if (cordisKeys.size >= CORDIS_EMBED_KEY_THRESHOLD) {
    evidence.push(`E2 cordis 运行时注册键指纹×${String(cordisKeys.size)}(${[...cordisKeys].join(',')})`)
  }
  if (evidence.length > 0) {
    findings.push(`[判据2·内嵌核心符号] ${filePath}: ${evidence.join(' ; ')}`)
  }
}

/**
 * 判据 3【防御深度级】：治理存储区 installed/**\/node_modules/@deepseek-ai/** 真实目录副本
 * （npm: 安装通道物理副本触发面——tarball 解包会把 dependencies 携带的核心包留成真实目录，
 * sandbox-b0 探针实证）。U1 降级注记：今日可达面为零（安装通道无 importer 的结构事实，
 * TC-B0 三值=不复现）；实现保留（只读扫描零误杀面）以预防未来接线变更静默复活触发面。
 * 深潜语义与带外 scanStorageDuplicates/walkForCoreCopies 同形：两级权威布局、
 * symlink/junction=正常不跟随（兼防链接环）、.dsh-guard-backup 不回扫（幂等）。
 */
function collectStorageCopyFindings(storageRoot: string, findings: string[]): void {
  const installedRoot = join(storageRoot, 'installed')
  if (!isDirSafe(installedRoot)) {
    return // 存储区未材质化=正常
  }
  for (const ns of readdirSync(installedRoot, { withFileTypes: true })) {
    if (!ns.isDirectory()) {
      continue // 链接/散文件非命名空间层（Dirent=lstat 语义，junction 亦报 link）
    }
    const nsDir = join(installedRoot, ns.name)
    for (const pluginEntry of readdirSync(nsDir, { withFileTypes: true })) {
      if (!pluginEntry.isDirectory()) {
        continue
      }
      walkForCoreCopies(join(nsDir, pluginEntry.name), findings)
    }
  }
}

/** 插件树深潜：任意深度 node_modules/@deepseek-ai 下的真实目录副本收集（只读）。 */
function walkForCoreCopies(dir: string, findings: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === GUARD_BACKUP_DIR_NAME) {
      continue // 带外自家备份区不回扫（幂等语义保真）
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      continue // 链接=非本树物理副本，不跟随（原件 isSymlink continue 判据，兼防链接环）
    }
    const entryPath = join(dir, entry.name)
    if (entry.name === CORE_SCOPE && basename(dir) === 'node_modules') {
      collectRealCopiesInScope(entryPath, findings)
      continue // 作用域内部不再深潜（带外同形）
    }
    walkForCoreCopies(entryPath, findings)
  }
}

/** 作用域目录内真实目录条目=物理副本（junction/symlink=正常跳过；散文件跳过）。 */
function collectRealCopiesInScope(scopeDir: string, findings: string[]): void {
  for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      continue
    }
    findings.push(`[判据3·存储区真实副本] ${join(scopeDir, entry.name)}`)
  }
}
