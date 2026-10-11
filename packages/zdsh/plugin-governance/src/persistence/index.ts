/**
 * 插件持久化管理
 *
 * 默认存储于用户主目录的 .dsh-zdsh-go 子目录（~/.dsh-zdsh-go）；环境变量
 * DSH_BRANCH_HOME 可显式覆盖；设置 DSH_HOME 时派生为 <DSH_HOME>/zdsh，
 * 使官方数据与 zDSH 数据收拢到同一安装目录内（自包含，可整体迁移/卸载）。
 *
 * 目录结构：
 * <storageRoot>/          # ~/.dsh-zdsh-go 或 <DSH_HOME>/zdsh
 * ├── registry.json      # 插件注册表
 * ├── cache/             # 缓存目录
 * ├── logs/              # 日志目录
 * ├── installed/         # npm 安装的插件
 * ├── presets/           # 预设文件
 * └── data/              # 数据目录
 */

export { PluginPersistence, createDefaultPersistence, DSH_BRANCH_DIR_NAME, DSH_BRANCH_HOME_ENV, resolveBranchStorageRoot } from './plugin-persistence.js'
export type { PluginPersistenceConfig } from './plugin-persistence.js'
