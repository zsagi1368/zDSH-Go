/**
 * HealthGuard - 健康检查守卫
 *
 * 定期检查插件健康状态，自动屏蔽故障插件。
 */

import { Plugin, PluginStatus, HealthReport, PluginRegistry } from '../spec/index.js'

/**
 * 健康检查配置项
 */
export interface HealthCheckOptions {
  intervalMs: number
  warningThreshold: number
  disableThreshold: number
}

/**
 * HealthGuard - 健康检查守卫
 *
 * 定期执行注册的健康检查，并根据连续失败次数升级插件状态
 * （警告 → 自动禁用）。
 */
export class HealthGuard {
  private healthChecks = new Map<string, HealthCheck>()
  private consecutiveFailures = new Map<string, number>()
  private monitoring = false
  private timer: ReturnType<typeof setInterval> | undefined

  private options: HealthCheckOptions = {
    intervalMs: 30000,
    warningThreshold: 3,
    disableThreshold: 5,
  }

  constructor(private registry: PluginRegistry) {}

  /**
   * 合并更新检查配置
   * @param options - 要覆盖的配置项（部分配置允许）。
   */
  setOptions(options: Partial<HealthCheckOptions>): void {
    this.options = { ...this.options, ...options }
  }

  /** 开始定期健康检查 */
  startMonitoring(): void {
    if (this.monitoring) return

    this.monitoring = true
    this.timer = setInterval(() => {
      void this.performHealthChecks()
    }, this.options.intervalMs)
  }

  /** 停止定期健康检查 */
  stopMonitoring(): void {
    this.monitoring = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * 注册某个插件的健康检查函数
   * @param pluginId - 插件 ID。
   * @param check - 健康检查函数。
   */
  registerCheck(pluginId: string, check: HealthCheck): void {
    this.healthChecks.set(pluginId, check)
  }

  /**
   * 注销某个插件的健康检查函数
   * @param pluginId - 插件 ID。
   */
  unregisterCheck(pluginId: string): void {
    this.healthChecks.delete(pluginId)
  }

  /**
   * 查询某个插件的连续失败次数
   * @param pluginId - 插件 ID。
   * @returns 连续失败次数（无记录时为 0）。
   */
  getConsecutiveFailures(pluginId: string): number {
    return this.consecutiveFailures.get(pluginId) || 0
  }

  private async performHealthChecks(): Promise<void> {
    for (const [pluginId, check] of this.healthChecks) {
      await this.performCheck(pluginId, check)
    }
  }

  private async performCheck(pluginId: string, check: HealthCheck): Promise<void> {
    const result = await check.run()
    const failures = this.consecutiveFailures.get(pluginId) || 0

    if (result.healthy) {
      this.consecutiveFailures.set(pluginId, 0)
      await this.updateStatus(pluginId, PluginStatus.ACTIVE)
    } else {
      const newFailures = failures + 1
      this.consecutiveFailures.set(pluginId, newFailures)

      if (newFailures >= this.options.warningThreshold && newFailures < this.options.disableThreshold) {
        await this.updateStatus(pluginId, PluginStatus.WARNINGS)
        this.notifyUser(pluginId, 'warning', result.error)
      } else if (newFailures >= this.options.disableThreshold) {
        await this.updateStatus(pluginId, PluginStatus.DISABLED)
        await this.disablePlugin(pluginId, result.error)
        this.notifyUser(pluginId, 'disabled', result.error)
      }
    }
  }

  private async updateStatus(pluginId: string, status: PluginStatus): Promise<void> {
    if (status === PluginStatus.ACTIVE) {
      await this.registry.enable(pluginId)
    } else if (status === PluginStatus.DISABLED) {
      await this.registry.disable(pluginId, 'auto-disabled')
    } else {
      /* v8 ignore next -- defensive ERROR passthrough: no current check outcome maps to ERROR. */
      this.registry.setStatus(pluginId, status)
    }
  }

  private async disablePlugin(pluginId: string, reason?: string): Promise<void> {
    try {
      await this.registry.disable(pluginId, reason || 'auto-disabled')
    } catch (error) {
      /* v8 ignore next -- DefaultPluginRegistry.disable never rejects; a custom registry failure must not break the check loop. */
      console.error(`[HealthGuard] Failed to disable plugin ${pluginId}:`, error)
    }
  }

  private notifyUser(pluginId: string, type: 'warning' | 'disabled', error?: string): void {
    // 发送通知
    console.log(`[HealthGuard] ${type.toUpperCase()}: Plugin ${pluginId} - ${error || 'Unknown error'}`)
  }

  /**
   * 汇总当前注册表内所有插件的健康报告
   * @returns 聚合后的健康报告。
   */
  getHealthReport(): HealthReport {
    const plugins = this.registry.getAll()
    const statusOf = (p: Plugin): PluginStatus => this.registry.getStatus(p.manifest.id)
    return {
      total: plugins.length,
      active: plugins.filter(p => statusOf(p) === PluginStatus.ACTIVE).length,
      warnings: plugins.filter(p => statusOf(p) === PluginStatus.WARNINGS).length,
      errors: plugins.filter(p => statusOf(p) === PluginStatus.ERROR).length,
      disabled: plugins.filter(p => statusOf(p) === PluginStatus.DISABLED).length,
      plugins: plugins.map((p) => {
        // getHealthStatus 在 Plugin 上是可选成员；三元读取以满足
        // no-unnecessary-condition 对可选链的判定。
        const health = p.getHealthStatus ? p.getHealthStatus() : undefined
        return {
          id: p.manifest.id,
          name: p.manifest.name,
          status: statusOf(p),
          errors: health?.errors,
          warnings: health?.warnings,
          lastError: health?.lastError,
          lastErrorTime: health?.lastErrorTime,
        }
      }),
    }
  }
}

/**
 * 健康检查接口
 */
export interface HealthCheck {
  run(): Promise<{ healthy: boolean; error?: string }>
}
