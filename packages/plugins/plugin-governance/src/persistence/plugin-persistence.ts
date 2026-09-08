/**
 * PluginPersistence - 插件持久化管理
 *
 * 将PluginRegistry的状态持久化到文件系统。
 * 默认使用用户主目录下的 .dsh-zdsh-go 子目录（~/.dsh-zdsh-go），与官方的 ~/.dsh/ 平行且互不干扰；
 * 环境变量 DSH_BRANCH_HOME 的覆盖优先级最高。
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import os from 'node:os'
import { PluginRegistry, PluginManifest } from '../spec/index.js'

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
 * packages/client/workbench/src/task-ledger.ts、独立仓 Workbench 与
 * PluginCenter 的同名逻辑。
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
   * 保存插件注册表到文件
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

    mkdirSync(dirname(this.registryPath), { recursive: true })
    writeFileSync(this.registryPath, JSON.stringify(data, null, 2))
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
