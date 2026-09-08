/**
 * extension/logic.js 的手写声明（纯文本，非构建产物）。
 *
 * 存在原因：tests/extension-logic.test.ts 在 TS strict（NodeNext）下直接
 * `import ... from '../extension/logic.js'`——NodeNext 会把 `.js` 说明符解析
 * 到同名 `.d.ts`，从而让 vitest 跑真 JS、tsc 查本声明，两侧零构建耦合。
 * 改 logic.js 导出时同步维护本文件。
 */

export declare const BRIDGE_PROTOCOL: string
export declare const DEFAULT_TICKET_TTL_MS: number
export declare const DEFAULT_HEARTBEAT_INTERVAL_MS: number
export declare const DEFAULT_PONG_TIMEOUT_MS: number
export declare const CLOSE_PAIR_REJECTED: number
export declare const CLOSE_PROTOCOL_VIOLATION: number
export declare const CLOSE_AUTH_FAILED: number

export declare const MAX_CONTENT_BYTES: number
export declare const LOAD_TIMEOUT_FRACTION: number
export declare const BACKOFF_BASE_MS: number
export declare const BACKOFF_MAX_MS: number
export declare const EXTRACT_RULE_SOURCE: string

export interface BridgeFrame {
  readonly [key: string]: unknown
}

export type ParseResult =
  | { readonly ok: true; readonly frame: BridgeFrame }
  | { readonly ok: false; readonly reason: string }

export interface ExtractedPage {
  readonly title: string
  readonly html: string
}

export declare function computeBackoffMs(attempt: number, baseMs?: number, maxMs?: number): number
export declare function shouldReconnect(closeCode: number, hasKey: boolean): boolean

export declare function createRequestIdAllocator(start?: number): () => number
export declare function createPairRequest(id: number, ticket: string): BridgeFrame
export declare function createAuthRequest(id: number, key: string): BridgeFrame
export declare function createRenderSuccess(
  id: number,
  content: string,
  statusCode?: number,
): BridgeFrame
export declare function createRenderFailure(id: number, error: string): BridgeFrame

export declare function parseFrame(raw: string): ParseResult
export declare function isRenderRequest(frame: unknown): boolean

export declare function clampLoadTimeout(timeoutMs: number, fraction?: number): number

export declare function utf8ByteLength(text: string): number
export declare function truncateContent(text: string, maxBytes?: number): string

export declare function runExtractRule(
  ruleSource?: string,
  documentLike?: unknown,
  maxBytes?: number,
): ExtractedPage
