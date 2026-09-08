/**
 * 凭据三级解析链（W-B-54 / F-008）：遗留字面值 → credentialRef → env，
 * 固定优先级（CREDS_SOURCE_ORDER）。安全不变量：
 *
 * - **明文不出闭包**：密钥本体只在本次解析调用的局部作用域内流转；
 *   快照里只有布尔态、掩码 hint（前 3 + 尾 4）与 opaque id（sha256 前 8 位）
 *   （W-B-55）。
 * - **占位符拦截**：配置里的 `<your-api-key>` 类样例值视为未配置
 *   （absent）并发出 `webstack.creds.placeholder-detected` 告警键，
 *   绝不让占位串冒充真实密钥流向引擎。
 * - **服务缺席跳级**：credentials seam 未注入时 credential-ref 层整体跳过，
 *   直接落到 env——能力缺失降级，不抛错（W-B-08 降级梯）。
 *
 * @module webstack/creds/resolve
 */

import { createHash } from 'node:crypto'
import type {
  CredSnapshotEntry,
  CredSource,
  CredsSnapshot,
  SeamCredentialsRuntime,
} from '../kernel/types.ts'
import { CREDS_SOURCE_ORDER } from '../kernel/types.ts'

export { CREDS_SOURCE_ORDER }

/** 典型占位符黑名单样例（文档性清单；运行时判定走 PLACEHOLDER_REGEX）。 */
export const PLACEHOLDER_PATTERNS = [
  '<your-key>',
  'your_api_key',
  'YOUR_API_KEY',
  'sk-xxx',
] as const

/**
 * 占位符检测正则：覆盖常见文档示例值（`<your…`、`your_api_key`、
 * `sk-xxx…`、`placeholder`、`changeme`）；另配「尖括号整体包裹」判定。
 */
const PLACEHOLDER_REGEX = /<your|your[_-]?api[_-]?key|sk-xxx{3,}|placeholder|changeme/i

/** 尖括号包裹判定：`<任何内容>` 一律视为占位符。 */
const ANGLE_WRAPPED_REGEX = /^<[^<>]*>$/

/** 解析选项。三个来源容器全部可选；seams 缺席时按降级梯跳级。 */
export interface ResolveCredsOptions {
  /** 设置面遗留字面值表（`engines.<id>.apiKey` 的当前快照）。 */
  configValues?: Readonly<Record<string, string | undefined>>
  /** 设置面 credentialRef 表（`engines.<id>.credentialRef` 的当前快照）。 */
  credentialsRef?: Readonly<Record<string, string | undefined>>
  /** 宿主接缝集合；目前仅消费 `credentials.resolve`。 */
  seams?: {
    credentials?: SeamCredentialsRuntime
  }
  /**
   * 非致命告警出口（如占位符命中）。键为 i18n 键（当前仅
   * `webstack.creds.placeholder-detected`），不放自由文本（W-B-53）。
   */
  onWarning?: (engineId: string, warningKey: string) => void
}

/** 引擎 id → env 变量名：`bing-lite` → `WEBSTACK_BING_LITE_API_KEY`。 */
export function envVarName(engineId: string): string {
  return `WEBSTACK_${engineId.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

/** 占位符判定：正则黑名单或尖括号整体包裹即命中。 */
export function isPlaceholderSecret(secret: string): boolean {
  const trimmed = secret.trim()
  return PLACEHOLDER_REGEX.test(trimmed) || ANGLE_WRAPPED_REGEX.test(trimmed)
}

/** 掩码 hint：长度 > 8 取前 3 + … + 尾 4；否则整串星号（不泄长度差信息过多）。 */
export function maskSecret(secret: string): string {
  return secret.length > 8
    ? `${secret.slice(0, 3)}…${secret.slice(-4)}`
    : '*'.repeat(secret.length)
}

/** opaque key id：sha256 前 8 位十六进制——可对比轮换，不可逆出原文。 */
export function opaqueIdOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8)
}

/** 构造 configured 条目；明文在此之后不再被引用（闭包边界）。 */
function configuredEntry(source: CredSource, secret: string): CredSnapshotEntry {
  return {
    state: 'configured',
    source,
    maskedHint: maskSecret(secret),
    opaqueId: opaqueIdOf(secret),
  }
}

/** absent 条目恒为裸形态（exactOptionalPropertyTypes 纪律：不带 undefined 字段）。 */
const ABSENT_ENTRY: CredSnapshotEntry = { state: 'absent' }

/** 视为「存在」的值：非 undefined 且去空白后非空。 */
function presentValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : value
}

/**
 * 三级链核心（内部）：逐引擎解析并**同时**收集明文密钥。
 * 明文只存在于本次调用的返回值内（进程内传递给引擎请求对象，W-B-55 的
 * 请求内延伸）；快照本体仍然只含布尔态/掩码/opaque id。
 */
async function resolveCore(
  engineIds: readonly string[],
  opts: ResolveCredsOptions,
): Promise<{ entries: Record<string, CredSnapshotEntry>; secrets: Record<string, string> }> {
  const entries: Record<string, CredSnapshotEntry> = {}
  const secrets: Record<string, string> = {}

  for (const engineId of engineIds) {
    let entry: CredSnapshotEntry = ABSENT_ENTRY
    let secret: string | undefined

    // 第 1 级：legacy-literal —— 配置面遗留字面值。
    const literal = presentValue(opts.configValues?.[engineId])
    if (literal !== undefined) {
      if (isPlaceholderSecret(literal)) {
        opts.onWarning?.(engineId, 'webstack.creds.placeholder-detected')
      } else {
        entry = configuredEntry('legacy-literal', literal)
        secret = literal
      }
    }

    // 第 2 级：credential-ref —— 经宿主 credentials 域解析；服务缺席跳级。
    const ref = presentValue(opts.credentialsRef?.[engineId])
    if (entry.state === 'absent' && ref !== undefined) {
      const resolved = await opts.seams?.credentials?.resolve(ref)
      const viaSeam = presentValue(resolved)
      if (viaSeam !== undefined && !isPlaceholderSecret(viaSeam)) {
        entry = configuredEntry('credential-ref', viaSeam)
        secret = viaSeam
      }
    }

    // 第 3 级：env —— 进程环境变量兜底。
    if (entry.state === 'absent') {
      const fromEnv = presentValue(process.env[envVarName(engineId)])
      if (fromEnv !== undefined && !isPlaceholderSecret(fromEnv)) {
        entry = configuredEntry('env', fromEnv)
        secret = fromEnv
      }
    }

    entries[engineId] = entry
    if (secret !== undefined) secrets[engineId] = secret
  }

  return { entries, secrets }
}

/**
 * 按三级链逐引擎解析凭据快照。每次搜索/抓取操作起点调用一次，
 * 操作内一致（W-B-74）；轮换密钥在下次调用即刻生效。
 *
 * 层内语义：
 * - legacy-literal 命中占位符 → 该层记 absent 并发告警，继续下探；
 * - credential-ref：ref 存在但 credentials seam 缺席 → 整层跳过；
 *   seam 在而 resolve 返回空 → 该引擎该层 absent，继续下探；
 * - env：变量名由 {@link envVarName} 派生，空串等同缺席。
 */
export async function resolveCreds(
  engineIds: readonly string[],
  opts: ResolveCredsOptions = {},
): Promise<CredsSnapshot> {
  const { entries } = await resolveCore(engineIds, opts)
  return { resolvedAt: Date.now(), entries }
}

/**
 * {@link resolveCreds} 的明文伴随版（装配层凭据流专用，W9）：快照语义完全
 * 一致，额外返回 `engineId → 明文密钥` 映射——仅供聚合器在同一操作起点把
 * 明文装进 EngineSearchRequest.credentials（仅进程内、仅请求生命周期），
 * 绝不落日志/缓存/模型上下文（W-B-55 纪律由调用方继续承担）。
 */
export async function resolveCredsDetailed(
  engineIds: readonly string[],
  opts: ResolveCredsOptions = {},
): Promise<{ snapshot: CredsSnapshot; secrets: Readonly<Record<string, string>> }> {
  const { entries, secrets } = await resolveCore(engineIds, opts)
  return { snapshot: { resolvedAt: Date.now(), entries }, secrets }
}

/**
 * 凭据指纹（进 CacheKeyInput.credFingerprint 维度）：各 configured 条目的
 * opaqueId 排序拼接再 sha256 取前 8 位。无任何凭据时返回 `'none'`——
 * 免 Key 引擎池因此获得稳定键；任一密钥轮换都会改变指纹 → 换键（W-B-30）。
 */
export function credFingerprint(snapshot: CredsSnapshot): string {
  const ids = Object.values(snapshot.entries)
    .map(entry => entry.opaqueId)
    .filter((id): id is string => typeof id === 'string')
    .toSorted()
  if (ids.length === 0) return 'none'
  return createHash('sha256').update(ids.join('')).digest('hex').slice(0, 8)
}
