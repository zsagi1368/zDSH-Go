/**
 * 渲染编排（F-201 桥接消费面）：把 BridgeServer 的原始 WS 往返包装成
 * webstack 内核的 SeamBridgeRuntime 同形接口。职责边界：
 *
 * - SSRF 复用：url 必须过 dsh-webstack 的 checkTarget（G1+G2）。为避免
 *   `dsh-webstack/src/safety/ssrf.js` 这类深路径耦合，校验函数经构造注入
 *   （deps.checkTarget / setTargetChecker），由装配层传入；**未注入即
 *   fail-closed**——渲染直接返回 undefined，绝不放行未检目标。
 * - 并发治理：浏览器标签页是稀缺资源，render() 请求排队串行执行，
 *   到达顺序即出站顺序。
 * - 降级语义：无连接、超时、SSRF 拒绝、断连一律 undefined + onDisconnect
 *   回调（内核降级 site: 搜索），绝不抛错、绝不半途悬挂。
 *
 * @module webstack-bridge/render
 */

import type { RenderResult } from './server.ts'

/**
 * 结构镜像（W-B-05 同款手法）：与 dsh-webstack `SeamBridgeRuntime.render`
 * 契约同形——本包不 import webstack 类型也能编译（结构兼容由装配层与
 * webstack 侧的契约测试共同锁死）。
 */
export interface SeamBridgeRuntimeShape {
  render(url: string, timeoutMs: number): Promise<RenderResult | undefined>
}

/** checkTarget 注入签名：webstack 的 `checkTarget(url, exemptions?)` 的子集像。 */
export type CheckTargetFn = (url: string) => Promise<SafetyVerdictLike>

/** SSRF 裁决最小像。 */
export interface SafetyVerdictLike {
  readonly allowed: boolean
}

export interface BridgeRendererDeps {
  /** 底层通道（BridgeServer 的结构子集；测试可注入替身）。 */
  readonly server: {
    requestRender(url: string, timeoutMs: number): Promise<RenderResult | undefined>
    onDisconnect(listener: () => void): () => void
    isConnected(): boolean
  }
  /** SSRF G1+G2 校验器；缺席 = fail-closed（见模块头）。 */
  readonly checkTarget?: CheckTargetFn
}

export class BridgeRenderer implements SeamBridgeRuntimeShape {
  private deps: BridgeRendererDeps
  private queueTail: Promise<unknown> = Promise.resolve()

  constructor(deps: BridgeRendererDeps) {
    this.deps = deps
  }

  /** 装配层后置注入 SSRF 校验器（如 peer 动态加载成功后的回填）。 */
  setTargetChecker(checkTarget: CheckTargetFn): void {
    this.deps = { ...this.deps, checkTarget }
  }

  get online(): boolean {
    return this.deps.server.isConnected()
  }

  /** 断连回调直通底层通道（内核降级 site: 搜索的触发点）。 */
  onDisconnect(listener: () => void): () => void {
    return this.deps.server.onDisconnect(listener)
  }

  /**
   * 串行渲染：并发调用按到达顺序排队；单个任务的超时/失败不传染后续。
   * 返回 undefined = 本次桥接不可用（含 SSRF 拒绝），调用方走降级链。
   */
  render(url: string, timeoutMs: number): Promise<RenderResult | undefined> {
    const job = this.queueTail.then(() => this.runOnce(url, timeoutMs))
    // 队尾推进与业务 promise 解耦：任何 rejection 都不会阻塞后续排队者。
    this.queueTail = job.then(
      () => undefined,
      () => undefined,
    )
    return job
  }

  private async runOnce(url: string, timeoutMs: number): Promise<RenderResult | undefined> {
    const checkTarget = this.deps.checkTarget
    if (checkTarget === undefined) return undefined // fail-closed：闸未装配
    let verdict: SafetyVerdictLike
    try {
      verdict = await checkTarget(url)
    } catch {
      // DNS 故障等按 fail-closed 归并为「桥不可用」，与 ssrf-blocked 同路降级。
      return undefined
    }
    if (!verdict.allowed) return undefined
    return this.deps.server.requestRender(url, timeoutMs)
  }
}
