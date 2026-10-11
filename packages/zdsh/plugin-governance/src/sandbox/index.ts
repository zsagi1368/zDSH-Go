/**
 * Sandbox - 沙箱工厂
 *
 * 根据插件配置选择合适的沙箱类型。
 */

import { PluginSandboxConfig, SandboxContext } from '../spec/index.js'
import { ProcessSandbox } from './process-sandbox.js'
import { WorkerSandbox } from './worker-sandbox.js'
import { InlineSandbox } from './inline-sandbox.js'

/**
 * 创建沙箱实例
 * @param pluginId - 插件 ID。
 * @param config - 沙箱配置。
 * @param entryPoint - 入口文件路径（process/worker 沙箱必填）。
 * @param hostGrantedFull - 宿主显式授予的完全执行权限（默认 false）。
 *   仅 process/inline 档使用：与 config.process.fullyAuthorized 同时为真才
 *   绕过命令白名单；manifest 自声明无法授予该权限（R-S43 前提 B fail-closed）。
 * @returns 对应类型的沙箱上下文实例。
 */
export function createSandbox(
  pluginId: string,
  config: PluginSandboxConfig,
  entryPoint?: string,
  hostGrantedFull = false,
): SandboxContext {
  switch (config.type) {
    case 'process':
      if (!entryPoint) {
        throw new Error('entryPoint is required for process sandbox')
      }
      return new ProcessSandbox(pluginId, config, entryPoint, hostGrantedFull)

    case 'worker':
      if (!entryPoint) {
        throw new Error('entryPoint is required for worker sandbox')
      }
      return new WorkerSandbox(pluginId, config, entryPoint)

    case 'inline':
      return new InlineSandbox(pluginId, config, hostGrantedFull)

    default:
      // The union is exhaustive; the cast guards decoded-JSON junk that bypasses
      // the type system, keeping the runtime fail-closed branch reachable.
      throw new Error(`Unknown sandbox type: ${config.type as string}`)
  }
}

/**
 * 根据风险等级选择沙箱类型
 * @param config - 原始沙箱配置。
 * @returns 带选定沙箱类型的配置副本。
 */
export function selectSandboxType(config: PluginSandboxConfig): PluginSandboxConfig {
  // 高风险插件使用进程隔离
  if (config.process.spawn || config.process.exec || config.network.access !== 'none') {
    return { ...config, type: 'process' }
  }

  // 中等风险使用 Worker Thread
  if (config.filesystem.access === 'readwrite') {
    return { ...config, type: 'worker' }
  }

  // 低风险可以直接在主线运行
  return { ...config, type: 'inline' }
}

export { ProcessSandbox } from './process-sandbox.js'
export { WorkerSandbox } from './worker-sandbox.js'
export { InlineSandbox } from './inline-sandbox.js'
export { checkPathAllowed } from './path-guard.js'
export { deriveSandboxEnvironment } from './env.js'
