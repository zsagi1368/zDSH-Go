/** W9 凭据槽位对照表：引擎 id → credSlot 单一事实源（装配层凭据流）。 */
import { describe, expect, it } from 'vitest'
import { credSlotOf, ENGINE_CRED_SLOTS } from '../src/creds/slots.ts'
import { ANYSEARCH_CRED_SLOT } from '../src/engines/anysearch.ts'
import { BRAVE_CRED_SLOT } from '../src/engines/brave.ts'
import { EXA_CRED_SLOT } from '../src/engines/exa.ts'
import { FIRECRAWL_CRED_SLOT } from '../src/engines/firecrawl.ts'
import { JINA_CRED_SLOT } from '../src/engines/jina.ts'
import { TAVILY_CRED_SLOT } from '../src/engines/tavily.ts'

describe('ENGINE_CRED_SLOTS 对照表', () => {
  it('六家 keyed 引擎全部登记且与适配器导出常量一致', () => {
    expect(ENGINE_CRED_SLOTS.tavily).toBe(TAVILY_CRED_SLOT)
    expect(ENGINE_CRED_SLOTS.brave).toBe(BRAVE_CRED_SLOT)
    expect(ENGINE_CRED_SLOTS.exa).toBe(EXA_CRED_SLOT)
    expect(ENGINE_CRED_SLOTS.jina).toBe(JINA_CRED_SLOT)
    expect(ENGINE_CRED_SLOTS.firecrawl).toBe(FIRECRAWL_CRED_SLOT)
    expect(ENGINE_CRED_SLOTS.anysearch).toBe(ANYSEARCH_CRED_SLOT)
  })

  it('对照表冻结：运行期不可增删改', () => {
    expect(Object.isFrozen(ENGINE_CRED_SLOTS)).toBe(true)
  })

  it('credSlotOf 已登记引擎返回槽位名', () => {
    expect(credSlotOf('tavily')).toBe('tavilyKey')
  })

  it('未登记引擎（免费池/MCP/原生/垂类）结构性免凭据 → undefined', () => {
    expect(credSlotOf('ddg')).toBeUndefined()
    expect(credSlotOf('bing-lite')).toBeUndefined()
    expect(credSlotOf('searxng')).toBeUndefined()
    expect(credSlotOf('native')).toBeUndefined()
    expect(credSlotOf('mcp-any')).toBeUndefined()
    expect(credSlotOf('x-vertical')).toBeUndefined()
  })
})
