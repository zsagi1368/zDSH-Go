/**
 * PluginRegistry - 插件注册表
 *
 * 管理所有已加载的插件，提供注册、查询、验证等功能。
 */

import {
  Plugin,
  PluginContext,
  PluginRegistry,
  RegistrationResult,
  ValidationResult,
  CompatibilityResult,
  HealthReport,
  PluginStatus,
  ValidationError,
  validatePluginId,
  normalizePluginId,
} from '../spec/index.js'
import { semverCompare, semverSatisfies } from '../semver.js'

/**
 * DefaultPluginRegistry - 默认插件注册表实现
 *
 * 管理所有已加载的插件：注册、验证、启用/禁用、状态跟踪与清理。
 */
export class DefaultPluginRegistry implements PluginRegistry {
  private plugins = new Map<string, Plugin>()
  private statusMap = new Map<string, PluginStatus>()
  private errors = new Map<string, string[]>()
  private warnings = new Map<string, string[]>()
  private disposables = new Map<string, Array<() => void>>()
  private debugMode = process.env.DSH_DEBUG === '1' || process.env.DSH_DEBUG === 'true'

  async register(plugin: Plugin): Promise<RegistrationResult> {
    // 验证插件 ID
    const normalizedId = normalizePluginId(plugin.manifest.id)
    if (!validatePluginId(normalizedId)) {
      return {
        success: false,
        pluginId: plugin.manifest.id,
        errors: [{ path: 'id', message: 'Invalid plugin ID format', severity: 'error' }],
      }
    }

    // 检查是否已注册
    if (this.plugins.has(normalizedId)) {
      return {
        success: false,
        pluginId: normalizedId,
        errors: [{ path: 'id', message: 'Plugin already registered', severity: 'error' }],
      }
    }

    // 验证插件（用规范化后的 ID，保持 dsh-* 旧格式可注册）
    const validation = this.validate(
      { ...plugin, manifest: { ...plugin.manifest, id: normalizedId } },
    )
    if (!validation.valid) {
      return {
        success: false,
        pluginId: normalizedId,
        errors: validation.errors,
      }
    }

    // 注册插件
    this.plugins.set(normalizedId, plugin)
    this.statusMap.set(normalizedId, PluginStatus.ACTIVE)
    this.disposables.set(normalizedId, [])

    // 调用 install
    try {
      await plugin.install(this.createContext(normalizedId))
      return { success: true, pluginId: normalizedId }
    } catch (error) {
      this.plugins.delete(normalizedId)
      this.statusMap.set(normalizedId, PluginStatus.ERROR)
      this.errors.set(normalizedId, [(error as Error).message])
      return {
        success: false,
        pluginId: normalizedId,
        errors: [{ path: 'install', message: (error as Error).message, severity: 'error' }],
      }
    }
  }

  async unregister(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return

    try {
      await plugin.uninstall?.(this.createContext(pluginId))
    } catch (error) {
      console.error(`Failed to uninstall plugin ${pluginId}:`, error)
    }

    this.plugins.delete(pluginId)
    this.statusMap.delete(pluginId)
    this.errors.delete(pluginId)
    this.warnings.delete(pluginId)
    this.disposables.delete(pluginId)
  }

  get(pluginId: string): Plugin | null {
    return this.plugins.get(pluginId) || null
  }

  getAll(): Plugin[] {
    return Array.from(this.plugins.values())
  }

  findByCapability(type: string, name: string): Plugin[] {
    return this.getAll().filter((p) => {
      return p.manifest.capabilities.some(c => c.type === type &&
        (type === 'tool' && c.tool?.name === name) ||
        (type === 'hook' && c.hook?.name === name) ||
        (type === 'service' && c.service?.name === name),
      )
    })
  }

  findActive(): Plugin[] {
    return this.getAll().filter(p => this.getStatus(p.manifest.id) === PluginStatus.ACTIVE)
  }

  findDisabled(): Plugin[] {
    return this.getAll().filter(p => this.getStatus(p.manifest.id) === PluginStatus.DISABLED)
  }

  getStatus(pluginId: string): PluginStatus {
    return this.statusMap.get(pluginId) || PluginStatus.ERROR
  }

  /**
   * Set warnings for a plugin and update status to WARNINGS if it was ACTIVE.
   */
  setPluginWarnings(pluginId: string, warnings: string[]): void {
    if (warnings.length > 0) {
      this.warnings.set(pluginId, warnings)
      // Upgrade status to WARNINGS only if currently ACTIVE
      if (this.statusMap.get(pluginId) === PluginStatus.ACTIVE) {
        this.statusMap.set(pluginId, PluginStatus.WARNINGS)
      }
    } else {
      this.warnings.delete(pluginId)
      // Downgrade back to ACTIVE if warnings are cleared and status is WARNINGS
      if (this.statusMap.get(pluginId) === PluginStatus.WARNINGS) {
        this.statusMap.set(pluginId, PluginStatus.ACTIVE)
      }
    }
  }

  getPluginWarnings(pluginId: string): string[] | undefined {
    return this.warnings.get(pluginId)
  }

  getHealthReport(): HealthReport {
    const plugins = this.getAll()
    return {
      total: plugins.length,
      active: plugins.filter(p => this.getStatus(p.manifest.id) === PluginStatus.ACTIVE).length,
      warnings: plugins.filter(p => this.getStatus(p.manifest.id) === PluginStatus.WARNINGS).length,
      errors: plugins.filter(p => this.getStatus(p.manifest.id) === PluginStatus.ERROR).length,
      disabled: plugins.filter(p => this.getStatus(p.manifest.id) === PluginStatus.DISABLED).length,
      plugins: plugins.map(p => ({
        id: p.manifest.id,
        name: p.manifest.name,
        status: this.getStatus(p.manifest.id),
        errors: this.errors.get(p.manifest.id),
        warnings: this.warnings.get(p.manifest.id),
      })),
    }
  }

  validate(plugin: Plugin): ValidationResult {
    const errors: ValidationError[] = []
    const warnings: ValidationError[] = []
    // 清单可能来自不受信来源，字段允许缺失；用宽松视图读取。
    const manifest = plugin.manifest as Partial<Plugin['manifest']>

    // 验证 ID
    if (!manifest.id || !validatePluginId(manifest.id)) {
      errors.push({ path: 'id', message: 'Invalid plugin ID format', severity: 'error' })
    }

    // 验证版本
    if (!manifest.version || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
      errors.push({ path: 'version', message: 'Invalid semver version', severity: 'error' })
    }

    // 验证能力
    if (!manifest.capabilities?.length) {
      errors.push({ path: 'capabilities', message: 'At least one capability required', severity: 'error' })
    }

    // 验证沙箱配置
    if (!manifest.sandbox) {
      errors.push({ path: 'sandbox', message: 'Sandbox config required', severity: 'error' })
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  checkCompatibility(plugin: Plugin, kernelVersion: string): CompatibilityResult {
    const compatible = (plugin.manifest as Partial<Plugin['manifest']>).dsh?.compatible || ''
    const issues: string[] = []

    // 简单兼容性检查
    if (compatible.includes('<')) {
      const maxVersion = compatible.split('<')[1]?.trim()
      // 上界排他：kernel 恰等于上界即在窗口外（与 LoadGuard 的 `>= 0` 对齐，NF1）。
      if (maxVersion && semverCompare(kernelVersion, maxVersion) >= 0) {
        issues.push(`Plugin requires DSH < ${maxVersion}`)
      }
    }

    if (compatible.includes('>=')) {
      const minVersion = compatible.split('>=')[1]?.split(' ')[0]
      if (minVersion && semverCompare(kernelVersion, minVersion) < 0) {
        issues.push(`Plugin requires DSH >= ${minVersion}`)
      }
    }

    // 检查 peer dependencies
    const peerDeps = (plugin.manifest as Partial<Plugin['manifest']>).dsh?.peerDependencies
    let peerDepsSatisfied = true
    if (peerDeps && Object.keys(peerDeps).length > 0) {
      for (const [depName, range] of Object.entries(peerDeps)) {
        // 在已注册插件中查找匹配的包（支持 namespace/name、@scope/name、dsh-xxx 等格式）
        const normalizedDep = normalizePluginId(depName)
        const depPlugin = this.plugins.get(normalizedDep) || this.plugins.get(depName)
        if (!depPlugin) {
          peerDepsSatisfied = false
          issues.push(`Peer dependency not satisfied: ${depName}@${range} (not registered)`)
        } else {
          const depVersion = depPlugin.manifest.version
          if (!semverSatisfies(depVersion, range)) {
            peerDepsSatisfied = false
            issues.push(`Peer dependency not satisfied: ${depName}@${depVersion} does not meet ${range}`)
          }
        }
      }
    }

    return {
      compatible: issues.length === 0,
      kernelVersion,
      requiredVersion: compatible,
      peerDepsSatisfied,
      issues,
    }
  }

  enable(pluginId: string): Promise<void> {
    this.statusMap.set(pluginId, PluginStatus.ACTIVE)
    this.errors.delete(pluginId)
    return Promise.resolve()
  }

  disable(pluginId: string, reason?: string): Promise<void> {
    this.statusMap.set(pluginId, PluginStatus.DISABLED)
    if (reason) {
      const errors = this.errors.get(pluginId) || []
      this.errors.set(pluginId, [...errors, reason])
    }
    return Promise.resolve()
  }

  setStatus(pluginId: string, status: PluginStatus): void {
    this.statusMap.set(pluginId, status)
  }

  async update(pluginId: string, newPlugin: Plugin): Promise<void> {
    await this.unregister(pluginId)
    await this.register(newPlugin)
  }

  /**
   * Dispose all registered plugins and clean up resources.
   */
  async dispose(): Promise<void> {
    const pluginIds = Array.from(this.plugins.keys())
    for (const pluginId of pluginIds) {
      try {
        // Run plugin-specific disposables first.
        /* v8 ignore next 1 -- register() seeds every id with an empty list, so the lookup cannot miss during dispose. */
        for (const fn of this.disposables.get(pluginId) ?? []) {
          try { fn() } catch { /* best-effort cleanup; dispose must keep going */ }
        }
        // Then call uninstall if available
        const plugin = this.plugins.get(pluginId)
        if (plugin?.uninstall) {
          await plugin.uninstall(this.createContext(pluginId))
        }
      } catch (error) {
        console.error(`Failed to dispose plugin ${pluginId}:`, error)
      } finally {
        this.plugins.delete(pluginId)
        this.statusMap.delete(pluginId)
        this.errors.delete(pluginId)
        this.warnings.delete(pluginId)
        this.disposables.delete(pluginId)
      }
    }
  }

  /**
   * Register a cleanup function for a plugin.
   * @param pluginId - the plugin's normalized id.
   * @param fn - the cleanup function to run on dispose.
   */
  registerDisposable(pluginId: string, fn: () => void): void {
    const disposables = this.disposables.get(pluginId)
    if (disposables) {
      disposables.push(fn)
    }
  }

  private createContext(pluginId: string): PluginContext {
    // In DEBUG mode, log a warning that this is a placeholder context
    if (this.debugMode) {
      console.warn(
        `[DSH DEBUG] createContext called for plugin "${pluginId}". ` +
        'The returned context is a minimal placeholder — services and sandbox are no-ops.',
      )
    }

    return {
      services: new Map(),
      emit: () => {},
      on: () => () => {},
      once: () => () => {},
      off: () => {},
      config: {},
      setConfig: () => {},
      getConfig: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
      effect: () => {},
      onDispose: (fn) => {
        this.registerDisposable(pluginId, fn)
      },
      logger: {
        info: (msg, meta) =>{  console.log(`[Plugin ${pluginId}] ${msg}`, meta ?? '') },
        warn: (msg, meta) =>{  console.warn(`[Plugin ${pluginId}] ${msg}`, meta ?? '') },
        error: (msg, meta) =>{  console.error(`[Plugin ${pluginId}] ${msg}`, meta ?? '') },
        debug: (msg, meta) => { if (this.debugMode) console.debug(`[Plugin ${pluginId}] ${msg}`, meta ?? '') },
      },
      status: PluginStatus.ACTIVE,
      setWarnings: (warnings: string[]) => {
        this.setPluginWarnings(pluginId, warnings)
      },
      markDeprecated: (_reason: string, _replaceWith?: string) => {
        this.statusMap.set(pluginId, PluginStatus.DEPRECATED)
      },
      sandbox: this.createMinimalSandbox(pluginId),
      registerCapability: () => {},
      unregisterCapability: () => {},
    }
  }

  /**
   * Create a minimal no-op SandboxContext for the placeholder PluginContext.
   */
  private createMinimalSandbox(_pluginId: string) {
    const noopResult = { exitCode: 0, stdout: '', stderr: '', duration: 0 }
    return {
      exec: () => Promise.resolve(noopResult),
      read: () => Promise.resolve(''),
      write: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    }
  }
}
