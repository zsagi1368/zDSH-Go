/**
 * PluginPersistence - 插件持久化管理
 *
 * 将PluginRegistry的状态持久化到文件系统。
 * 默认使用用户主目录下的 .dsh-zdsh-go 子目录（~/.dsh-zdsh-go），与官方的 ~/.dsh/ 平行且互不干扰；
 * 环境变量 DSH_BRANCH_HOME 的覆盖优先级最高。
 */

import { randomBytes } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import os from 'node:os'
import { PluginRegistry, PluginManifest } from '../spec/index.js'

/* ------------------------------------------------------------------ *
 * 注册表快照原子写（同步形私有件，TC-B4-H1 面四=FB5 清偿）
 *
 * 与 host 包 src/atomic-write-sync.ts 同语义的**文件内私有镜像**——内核保持
 * 「零新增包依赖，纯 node 内建」纪律（load-guard.ts 头注同策；勘误见
 * RECEIPT-H1 §2.2：@deepseek-ai/dsh-atomic-write 的 writeFileAtomic 为
 * async 形且非本包依赖，直接换用需 async 化同步调用链=契约面扩展）。
 * 语义逐条对齐原件：随机后缀 sibling temp + `wx` 独占创建（拒跟随 temp 位
 * 种植链接）+ mode 0o600 随新 inode 过 rename（注册表快照含插件清单与操作者
 * 启停决策）+ rename 原子提交（无锁读者只见完整旧内容或完整新内容）+
 * win32 瞬态 EACCES/EBUSY/EPERM 有界退避重试（20ms 倍增封顶 200ms、8 次）+
 * 失败清 temp 重抛（调用方补偿依赖原错误）。崩溃耐久性（fsync）与原包协议
 * 同款不在范围。
 * ------------------------------------------------------------------ */

/** 注册表快照文件权限位（用户决策数据，D1b FB5 建议原文 mode）。 */
const REGISTRY_FILE_MODE = 0o600

/** win32 瞬态 rename 干扰错误码集（atomic-write 包镜像）。 */
const TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])

/** 有界同步退避（Atomics.wait 一次性缓冲；镜像原件 async setTimeout 节奏）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** rename 原子提交腿：win32 瞬态干扰有界重试，其余错误即刻重抛。 */
function renameAtomicTempSync(temp: string, filename: string): void {
  let delay = 20
  for (let retries = 0;; retries += 1) {
    try {
      renameSync(temp, filename)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
      const transient = process.platform === 'win32' && TRANSIENT_RENAME_ERRORS.has(code)
      if (!transient) throw error
      if (retries >= 8) throw error
    }
    sleepSync(delay)
    delay = Math.min(delay * 2, 200)
  }
}

/**
 * 以单次原子替换把 `content` 落到 `filename`（创建父目录；失败时清除 temp、
 * 目标文件保持旧内容完整、原错误重抛）。
 */
function writeFileAtomicSyncLocal(filename: string, content: string): void {
  mkdirSync(dirname(filename), { recursive: true })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, content, { mode: REGISTRY_FILE_MODE, flag: 'wx' })
    renameAtomicTempSync(temp, filename)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败不得掩盖调用方补偿所依赖的主错误。
    }
    throw error
  }
}

/**
 * 默认数据存储目录名称（位于用户主目录下，即 ~/.dsh-zdsh-go）
 * 与官方的 ~/.dsh 对应，但完全独立，不会冲突
 */
export const DSH_BRANCH_DIR_NAME = '.dsh-zdsh-go'

/**
 * 环境变量名称（用于自定义存储位置）
 * 与官方的 DSH_HOME 对应
 */
export const DSH_BRANCH_HOME_ENV = 'DSH_BRANCH_HOME'

/**
 * 解析 zDSH 分支数据存储根目录（权威实现，全项目共享此优先级链）。
 *
 * 优先级（高 → 低）：
 * 1. `DSH_BRANCH_HOME` 环境变量（兼容保留的显式覆盖入口）
 * 2. `DSH_HOME` 环境变量派生：`<DSH_HOME>/zdsh` —— 单变量统一入口，设置一个
 *    DSH_HOME 即可让官方数据与 zDSH 数据全部收拢到同一安装目录内
 * 3. `~/.dsh-zdsh-go`（历史默认，行为与未引入 DSH_HOME 派生前完全一致）
 *
 * 镜像实现方（修改时同步）：plugin-governance/src/invariant.ts、
 * plugin-project-root/src/invariant.ts（经本包导出复用）、
 * 独立仓 Workbench（zdsh-workbench，出厂装件）与 PluginCenter 的同名逻辑。
 * @param env - 环境变量来源，默认 `process.env`（注入以便测试）。
 * @returns 绝对存储根目录路径。
 */
export function resolveBranchStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  const branchHome = env[DSH_BRANCH_HOME_ENV]
  if (branchHome !== undefined && branchHome.trim().length > 0) {
    return resolve(branchHome)
  }
  const dshHome = env.DSH_HOME
  if (dshHome !== undefined && dshHome.trim().length > 0) {
    return join(resolve(dshHome), 'zdsh')
  }
  return join(os.homedir(), DSH_BRANCH_DIR_NAME)
}

/**
 * 插件持久化配置
 */
export interface PluginPersistenceConfig {
  /** 数据根目录（默认：~/.dsh-zdsh-go，可用 DSH_BRANCH_HOME 覆盖） */
  storageRoot?: string | undefined
  /** 是否自动保存 */
  autoSave?: boolean | undefined
  /** 保存间隔（毫秒） */
  saveIntervalMs?: number | undefined
}

/** registry.json 落盘格式 */
interface PersistedRegistry {
  version: string
  savedAt: string
  storageRoot: string
  plugins: Array<{ id: string; name: string; version: string; status: string; manifest: PluginManifest }>
}

/** 收窄 JSON.parse 结果：合法的落盘注册表形状 */
function isPersistedRegistry(value: unknown): value is PersistedRegistry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { plugins?: unknown }
  return Array.isArray(candidate.plugins)
}

/** 解析完成（无 undefined 洞）的持久化配置 */
interface ResolvedPersistenceConfig {
  storageRoot: string
  autoSave: boolean
  saveIntervalMs: number
}

/**
 * PluginPersistence - 插件持久化管理器
 *
 * 所有插件配置、缓存、日志都存储在用户主目录的 .dsh-zdsh-go 子目录中，
 * 完全独立于官方的 ~/.dsh/ 目录，不会冲突。
 *
 * 目录结构：
 * ~/.dsh-zdsh-go/
 * ├── registry.json      # 插件注册表
 * ├── cache/             # 缓存目录
 * ├── logs/              # 日志目录
 * └── data/              # 数据目录
 */
export class PluginPersistence {
  private config: ResolvedPersistenceConfig
  private registry: PluginRegistry
  private saveTimer: ReturnType<typeof setInterval> | null = null

  constructor(registry: PluginRegistry, config?: PluginPersistenceConfig) {
    this.registry = registry
    this.config = {
      storageRoot: config?.storageRoot ?? this.resolveDefaultStorageRoot(),
      autoSave: config?.autoSave ?? true,
      saveIntervalMs: config?.saveIntervalMs ?? 60000,
    }
  }

  /**
   * 解析默认存储根目录
   *
   * 优先级：
   * 1. 配置参数 storageRoot
   * 2. 环境变量 DSH_BRANCH_HOME（覆盖优先级最高的环境入口，兼容保留）
   * 3. 环境变量 DSH_HOME 派生：$DSH_HOME/zdsh（单变量统一入口，官方数据与
   *    zDSH 数据同根，整个安装目录自包含）
   * 4. 用户主目录下的 .dsh-zdsh-go
   *
   * 与官方的 DSH_HOME 机制对应：
   * - 官方: DSH_HOME -> ~/.dsh
   * - 我们: DSH_HOME -> <DSH_HOME>/zdsh（新）或 DSH_BRANCH_HOME -> ~/.dsh-zdsh-go（兼容）
   */
  private resolveDefaultStorageRoot(): string {
    return resolveBranchStorageRoot(process.env)
  }

  /**
   * 获取数据目录路径
   */
  get storagePath(): string {
    return this.config.storageRoot
  }

  /**
   * 获取插件注册表文件路径
   */
  get registryPath(): string {
    return join(this.config.storageRoot, 'registry.json')
  }

  /**
   * 获取插件缓存目录
   */
  get cacheDir(): string {
    return join(this.config.storageRoot, 'cache')
  }

  /**
   * 获取插件日志目录
   */
  get logDir(): string {
    return join(this.config.storageRoot, 'logs')
  }

  /**
   * 获取插件数据目录
   */
  get dataDir(): string {
    return join(this.config.storageRoot, 'data')
  }

  /**
   * 启动持久化
   */
  start(): void {
    if (this.config.autoSave) {
      this.saveTimer = setInterval(() => {
        this.save()
      }, this.config.saveIntervalMs)
    }
  }

  /**
   * 停止持久化
   */
  stop(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer)
      this.saveTimer = null
    }
  }

  /**
   * 保存插件注册表到文件（单次原子替换=FB5：崩溃于写中不再把快照损坏成
   * load 侧空数组形——持久 disabled 决策/MM1b「不复活」语义的载体完整性
   * 由 rename 提交承载；同步签名零变更，persistRegistryChange 同步补偿链
   * 与 autoSave 定时器语义零触碰）。
   */
  save(): void {
    const plugins = this.registry.getAll()
    const data: PersistedRegistry = {
      version: '1.0.0',
      savedAt: new Date().toISOString(),
      storageRoot: this.config.storageRoot,
      plugins: plugins.map(p => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        status: this.registry.getStatus(p.manifest.id),
        manifest: p.manifest,
      })),
    }

    writeFileAtomicSyncLocal(this.registryPath, JSON.stringify(data, null, 2))
  }

  /**
   * 从文件加载插件注册表
   * @returns 从文件解析出的插件清单（文件缺失或内容不受信时返回空数组）。
   */
  load(): PluginManifest[] {
    if (!existsSync(this.registryPath)) {
      return []
    }

    const parsed: unknown = JSON.parse(readFileSync(this.registryPath, 'utf-8'))
    if (!isPersistedRegistry(parsed)) {
      return []
    }
    const manifests: PluginManifest[] = []
    for (const entry of parsed.plugins as Array<unknown>) {
      // 落盘内容不受信：逐条收窄后再取 manifest。
      if (entry && typeof entry === 'object' && 'manifest' in entry) {
        manifests.push((entry as { manifest: PluginManifest }).manifest)
      }
    }
    return manifests
  }

  /**
   * 确保所有必要目录存在
   */
  ensureDirectories(): void {
    mkdirSync(this.config.storageRoot, { recursive: true })
    mkdirSync(this.cacheDir, { recursive: true })
    mkdirSync(this.logDir, { recursive: true })
    mkdirSync(this.dataDir, { recursive: true })
  }

  /**
   * 清理所有数据
   */
  clear(): void {
    rmSync(this.config.storageRoot, { recursive: true, force: true })
  }
}

/**
 * 创建默认的PluginPersistence实例
 * 使用用户主目录 ~/.dsh-zdsh-go 作为存储根目录
 * @param registry - 持久化要关联的插件注册表。
 * @returns 默认的插件持久化实例。
 */
export function createDefaultPersistence(registry: PluginRegistry): PluginPersistence {
  return new PluginPersistence(registry)
}
