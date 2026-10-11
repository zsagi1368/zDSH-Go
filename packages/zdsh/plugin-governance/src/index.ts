/**
 * DSH Plugin Governance System
 *
 * 插件治理体系主入口，导出所有公共 API。
 */

// 核心类型和接口
export * from './spec/index.js'

// 插件基类
export * from './base/base.js'

// 沙箱系统
export * from './sandbox/index.js'

// 守卫机制
export * from './guards/load-guard.js'
export * from './guards/run-guard.js'
export * from './guards/health-guard.js'
export * from './guards/watcher.js'

// 插件注册表
export * from './registry/registry.js'

// Cordis 兼容性适配
export * from './compat/cordis-adapter.js'

// 插件持久化管理（独立存储位置）
export * from './persistence/index.js'
