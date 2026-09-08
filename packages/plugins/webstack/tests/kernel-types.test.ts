/**
 * 契约冻结的结构断言（W-B-07）：把「我们依赖的平台约定」写成对自身类型与
 * 宿主真实类型的编译期+运行期断言。宿主演进破坏结构兼容时这里先红。
 */
import type {
  WebFetchProvider,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type CacheKeyInput,
  type NormalizedHit,
  SEARCH_LAYERS,
  type SeamWebFetchProvider,
  type SeamWebSearchProvider,
  type SeamWebSearchRequest,
  type SeamWebSearchResult,
  type SeamWebSearchSource,
} from '../src/kernel/types.ts'

describe('HostSeams 结构镜像契约（W-B-05）', () => {
  it('镜像 provider 可直接赋给宿主 dsh-web 的 provider 接口（结构兼容锁死）', () => {
    expectTypeOf<SeamWebSearchProvider>().toExtend<WebSearchProvider>()
    expectTypeOf<SeamWebFetchProvider>().toExtend<WebFetchProvider>()
    expectTypeOf<SeamWebSearchRequest>().toExtend<WebSearchRequest>()
    expectTypeOf<SeamWebSearchResult>().toExtend<WebSearchResult>()
    expectTypeOf<SeamWebSearchSource>().toExtend<WebSearchSource>()
  })
})

describe('NormalizedHit 最小字段集（W-B-93）', () => {
  it('url/title 必填、provenance.engine 必填，其余可选缺席合法', () => {
    const minimal: NormalizedHit = {
      url: 'https://example.com/FirstSeen?Case=Matters',
      title: 'Example',
      provenance: { engine: 'ddg' },
    }
    expectTypeOf(minimal.url).toEqualTypeOf<string>()
    expectTypeOf(minimal.provenance.engine).toEqualTypeOf<string>()
    expectTypeOf<NormalizedHit['publishedAt']>().toEqualTypeOf<string | undefined>()
  })
})

describe('CacheKeyInput 维度清单（W-B-33）', () => {
  it('键维度字段名冻结：新增维度必须显式改契约', () => {
    expectTypeOf<keyof CacheKeyInput>().toEqualTypeOf<
      'layer' | 'engineSet' | 'count' | 'hints' | 'tier' | 'credFingerprint' | 'options'
    >()
  })
})

describe('路由层词汇', () => {
  it('SEARCH_LAYERS 为封闭五层枚举', () => {
    expect([...SEARCH_LAYERS]).toEqual(['native', 'free', 'api', 'selfhosted', 'mcp'])
  })
})
