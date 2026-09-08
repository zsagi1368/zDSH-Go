/**
 * 宿主能力探测与降级梯（W-B-08 / F-013）：activate 时对宿主逐一探测耦合点，
 * 产出 CapabilityBitmap，据此选择运行档位 takeover → coexist → diagnostic。
 * 每个探测函数唯一归口本文件；位图变化写入加载标记日志（W-B-78）。
 * TODO(W2-PLATFORM): selectorPatchable/bridgeOnline 的运行期回读验证。
 * @module webstack/kernel/capability
 */

import type { CapabilityBitmap, TierMode } from './types.ts'

/** 全部位为 false 的空位图（诊断档基线）。 */
export function emptyBitmap(): CapabilityBitmap {
  return {
    webSeam: false,
    selectorPatchable: false,
    settingsSection: false,
    inputSlot: false,
    credentialsDomain: false,
    storageService: false,
    bridgeOnline: false,
  }
}

/**
 * 对未知宿主上下文做结构探测。只做 `typeof === 'function'` 级廉价检查，
 * 不触发任何服务实例化或网络行为。cordis 的未装载服务属性在访问时会
 * **抛错**而非返回 undefined——探测永不抛（W-B-47 缺失分支），逐项兜底。
 */
export function probeCapabilities(ctx: unknown): CapabilityBitmap {
  const bitmap = emptyBitmap()
  if (typeof ctx !== 'object' || ctx === null) return bitmap
  const record = ctx as Record<string, unknown>
  const peek = (key: string): unknown => {
    try {
      return record[key]
    } catch {
      return undefined
    }
  }
  const web = peek('web') as Record<string, unknown> | undefined
  bitmap.webSeam =
    typeof web?.registerSearchProvider === 'function' &&
    typeof web?.registerFetchProvider === 'function'
  const isObjectLike = (value: unknown): boolean => typeof value === 'object' && value !== null
  bitmap.settingsSection = isObjectLike(peek('settings'))
  bitmap.credentialsDomain = isObjectLike(peek('credentials'))
  bitmap.storageService = isObjectLike(peek('storage'))
  return bitmap
}

/**
 * 由能力位图推导运行档位：
 * - webSeam 且选择器可被 patch 指向 → 接管档；
 * - 仅 webSeam → 共存档（注册为可选 provider，用户手动选）;
 * - 其余 → 只读诊断档（仅命令与设置，提示升级）。
 */
export function deriveTierMode(bitmap: CapabilityBitmap): TierMode {
  if (bitmap.webSeam && bitmap.selectorPatchable) return 'takeover'
  if (bitmap.webSeam) return 'coexist'
  return 'diagnostic'
}
