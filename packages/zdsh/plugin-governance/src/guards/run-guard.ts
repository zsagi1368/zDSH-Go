/**
 * RunGuard - 运行时守卫
 *
 * 监控插件运行时行为，包括超时、内存、调用次数等。
 */

import { Plugin } from '../spec/index.js'
import { PluginWatcher } from './watcher.js'

/**
 * RunGuard - 运行时守卫
 *
 * 为每个被监控插件维护一个 PluginWatcher，跟踪运行时行为
 * （超时、内存、调用次数等）。
 */
export class RunGuard {
  private watchers = new Map<string, PluginWatcher>()

  /**
   * 为插件创建并登记监控器；同一插件重复登记会抛错。
   * @param pluginId - 插件 ID。
   * @param plugin - 待监控的插件实例。
   * @returns 新建的监控器。
   */
  watch(pluginId: string, plugin: Plugin): PluginWatcher {
    if (this.watchers.has(pluginId)) {
      throw new Error(`Watcher already exists for plugin: ${pluginId}`)
    }

    const watcher = new PluginWatcher(pluginId, plugin)
    this.watchers.set(pluginId, watcher)
    return watcher
  }

  /**
   * 移除某个插件的监控器（若存在）。
   * @param pluginId - 插件 ID。
   */
  unwatch(pluginId: string): void {
    this.watchers.delete(pluginId)
  }

  /**
   * 在对应监控器下执行一次调用，施加超时与调用次数控制。
   * @param pluginId - 插件 ID。
   * @param fn - 要执行的异步函数。
   * @param _context - 预留的调用上下文（当前未使用）。
   * @returns 函数执行结果。
   */
  async execute<T>(
    pluginId: string,
    fn: () => Promise<T>,
    _context?: Record<string, unknown>,
  ): Promise<T> {
    const watcher = this.watchers.get(pluginId)
    if (!watcher) {
      throw new Error(`No watcher for plugin: ${pluginId}`)
    }

    return watcher.execute(fn)
  }

  /**
   * 当前被监控的插件 ID 列表。
   * @returns 已登记监控器的插件 ID。
   */
  getActiveWatchers(): string[] {
    return Array.from(this.watchers.keys())
  }

  /**
   * 查询某个插件的监控器。
   * @param pluginId - 插件 ID。
   * @returns 对应的监控器，未登记时返回 undefined。
   */
  getWatcher(pluginId: string): PluginWatcher | undefined {
    return this.watchers.get(pluginId)
  }
}
