/**
 * 引擎 id → 请求级凭据槽位名映射（W9 装配层凭据流的唯一对照表）：
 * 聚合器把 resolveCredsDetailed 解析出的明文按本表装进
 * EngineSearchRequest.credentials（键 = 槽位名，值 = 明文，仅进程内传递）。
 * 槽位名以各引擎适配器导出的常量为单一事实源；未登记的引擎 = 无凭据槽
 * （免费池/自托管/MCP/原生/垂类均结构性免凭据，W-B-12）。
 *
 * @module webstack/creds/slots
 */

import { ANYSEARCH_CRED_SLOT } from '../engines/anysearch.ts'
import { BRAVE_CRED_SLOT } from '../engines/brave.ts'
import { EXA_CRED_SLOT } from '../engines/exa.ts'
import { FIRECRAWL_CRED_SLOT } from '../engines/firecrawl.ts'
import { JINA_CRED_SLOT } from '../engines/jina.ts'
import { TAVILY_CRED_SLOT } from '../engines/tavily.ts'

/** 引擎 id → credSlot 常量映射（冻结；新增 keyed 引擎 = 在此登记一行）。 */
export const ENGINE_CRED_SLOTS: Readonly<Record<string, string>> = Object.freeze({
  tavily: TAVILY_CRED_SLOT,
  brave: BRAVE_CRED_SLOT,
  exa: EXA_CRED_SLOT,
  jina: JINA_CRED_SLOT,
  firecrawl: FIRECRAWL_CRED_SLOT,
  anysearch: ANYSEARCH_CRED_SLOT,
})

/** 取引擎的凭据槽位名；未登记引擎返回 undefined（无凭据通道）。 */
export function credSlotOf(engineId: string): string | undefined {
  return ENGINE_CRED_SLOTS[engineId]
}
