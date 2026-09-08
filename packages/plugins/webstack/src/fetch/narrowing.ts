/**
 * 响应统一窄化层（W-B-52）：手写类型收窄读取器。不信任任何响应形状——
 * 缺失/类型不符一律转结构化结果，绝不抛裸 TypeError。
 *
 * 跨模块共享说明：`parseJsonLoose` / `narrowString` / `narrowArray` /
 * `narrowRecord` 的签名与 `src/engines/engine.ts` 中的本地结构类型
 * （ParseJsonLooseFn 等）逐字对齐——改形状 = 契约变更，须同步引擎侧注释。
 *
 * @module webstack/fetch/narrowing
 */

/** 安全地把 unknown 收窄为普通记录；原型链对象与数组一律拒绝。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 宽松 JSON 解析成功分支：value 为 `JSON.parse` 的原始产物。 */
export interface JsonLooseOk {
  readonly ok: true
  readonly value: unknown
}

/** 宽松 JSON 解析失败分支：reason 携带解析器的原始错误信息（可诊断）。 */
export interface JsonLooseErr {
  readonly ok: false
  readonly reason: string
}

/**
 * 宽松 JSON 解析（W-B-52）：把「响应文本不是合法 JSON」从异常降级为结构化
 * 数据（ok:false），调用方据此走回退分支而非崩溃。仅做 `JSON.parse` 的
 * try/catch 包装，不做任何修复/容错改写——垃圾进、结构化错误出。
 */
export function parseJsonLoose(text: string): JsonLooseOk | JsonLooseErr {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, reason }
  }
}

/**
 * 安全收窄 unknown → 非空 string：仅当值本来就是 string 且长度 > 0 时返回，
 * 其余（数字/空串/null/undefined/对象）一律 undefined。
 */
export function narrowString(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined
  return v
}

/**
 * 安全收窄 unknown → 只读数组：仅真数组放行（元素保持 unknown 不预校验，
 * 由调用方逐项窄化）；其余一律退空数组，保证调用方可直接迭代。
 */
export function narrowArray(v: unknown): readonly unknown[] {
  if (!Array.isArray(v)) return []
  return v
}

/**
 * 安全收窄 unknown → 只读记录：普通对象（非数组、非 null）放行；其余
 * undefined。与 {@link asRecord} 同判据，仅多一层只读视图约束。
 */
export function narrowRecord(v: unknown): Readonly<Record<string, unknown>> | undefined {
  return asRecord(v)
}
