import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

/**
 * 探测失败的原因分类。
 * - 'module-not-found': 模块说明符无法解析（未安装/未导出）。
 * - 'symbol-missing': 模块可导入，但不导出指定符号。
 * - 'shape-mismatch': 符号存在，但未通过 shape 校验。
 * - 'import-threw': 动态 import 本身抛错（模块求值异常等）。
 */
export type ProbeReason =
  | 'module-not-found'
  | 'symbol-missing'
  | 'shape-mismatch'
  | 'import-threw'

/**
 * probeSymbol 的探测结果。
 */
export interface ProbeResult<T = unknown> {
  /** 模块可导入、符号存在且通过 shape 校验。 */
  present: boolean
  /** 符号值（present 时）。 */
  value: T | undefined
  /** 失败原因（present=false 时）。 */
  reason: ProbeReason | undefined
  /** 原始错误，供日志。 */
  error?: unknown
}

const MODULE_RESOLUTION_ERROR_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
  'MODULE_NOT_FOUND',
])

const MODULE_RESOLUTION_ERROR_MESSAGE =
  /(?:cannot find (?:module|package)|failed to fetch dynamically imported module)/i

/**
 * 判断动态 import 抛出的错误是否属于「模块解析失败」。
 * Node 侧看 error.code（ERR_MODULE_NOT_FOUND 等），bundler/浏览器侧按消息形态兜底。
 * @param error - import 抛出的原始错误。
 * @returns 是否为模块解析失败。
 */
function isModuleResolutionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  if ('code' in error && typeof error.code === 'string' && MODULE_RESOLUTION_ERROR_CODES.has(error.code)) {
    return true
  }
  return MODULE_RESOLUTION_ERROR_MESSAGE.test(error.message)
}

/**
 * 动态探测一个模块是否可导入且导出指定符号，形状不匹配也算缺失。
 * 失败永不 throw；用于版本感知：优先探测新版符号，缺失时回退旧版。
 * @param specifier - 要动态 import 的模块说明符（如 '@deepseek-ai/dsh-api-remotes/client'）。
 * @param symbol - 要探测的具名导出（如 'LlmConfigurableProvider'）。
 * @param shape - 可选的形状校验器；对导出的值做 typeof / 字段检查，返回 true 才认为存在。
 * @returns 探测结果（value 可能为 undefined）。
 */
export async function probeSymbol<T = unknown>(
  specifier: string,
  symbol: string,
  shape?: (value: unknown) => boolean,
): Promise<ProbeResult<T>> {
  try {
    const namespace = (await import(specifier)) as Record<string, unknown>
    if (!(symbol in namespace)) {
      return { present: false, value: undefined, reason: 'symbol-missing' }
    }
    const value = namespace[symbol]
    if (shape && !shape(value)) {
      return { present: false, value: undefined, reason: 'shape-mismatch' }
    }
    return { present: true, value: value as T, reason: undefined }
  } catch (error) {
    const reason = isModuleResolutionError(error) ? 'module-not-found' : 'import-threw'
    return { present: false, value: undefined, reason, error }
  }
}

/**
 * 同步读取已加载模块的导出形状（非动态 import），用于静态别名场景。
 * @param namespace - 已静态 import 的模块命名空间对象。
 * @param symbol - 要检查的导出名。
 * @returns 符号值或 undefined。
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- design-mandated generic return shape.
export function memberOf<T = unknown>(namespace: object, symbol: string): T | undefined {
  if (!(symbol in namespace)) {
    return undefined
  }
  return (namespace as Record<string, unknown>)[symbol] as T
}

/**
 * 读取一个已安装包的版本号（host 侧）；失败返回 undefined 而不是抛错。
 * 用于区分「官方 0.1.2-alpha.1 / zDSH 0.1.1-rc.2」等版本档位。
 * @param packageName - 包名（如 '@deepseek-ai/dsh-llm'）。
 * @returns 包的 version 字段；读取失败返回 undefined。
 */
export async function versionOf(packageName: string): Promise<string | undefined> {
  try {
    const nodeRequire = createRequire(import.meta.url)
    const pkgJsonPath = nodeRequire.resolve(`${packageName}/package.json`)
    const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}
