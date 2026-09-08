/** 正文抽取：htmlToText / extractReadable / renderExtract 回退链（F-004）。 */
import { describe, expect, it } from 'vitest'
import {
  CITATION_HEAD_CHARS,
  EXTRACT_FALLBACK_CHAIN,
  extractReadable,
  htmlToText,
  renderExtract,
} from '../src/fetch/extract.ts'

describe('EXTRACT_FALLBACK_CHAIN', () => {
  it('顺序为 raw → fit → citations', () => {
    expect([...EXTRACT_FALLBACK_CHAIN]).toEqual(['raw', 'fit', 'citations'])
  })
})

describe('htmlToText（HTML → 纯文本）', () => {
  it('script/style/nav/footer/header 整块剔除', () => {
    const html =
      '<nav>菜单</nav><p>正文</p><script>alert("<p>假正文</p>");</script><style>.a{color:red}</style><footer>版权</footer>'
    expect(htmlToText(html)).toBe('正文')
  })

  it('块级标签 br/p/div/li/h1-h6/tr 转换行；连续块只留一个换行', () => {
    expect(htmlToText('<p>甲</p><p>乙</p>')).toBe('甲\n乙')
    expect(htmlToText('<h1>标题</h1><div><li>项</li></div>')).toBe('标题\n项')
    expect(htmlToText('行一<br>行二')).toBe('行一\n行二')
  })

  it('非块级标签剔除但内容保留，水平空白压缩', () => {
    expect(htmlToText('<span>A</span>   <b>B</b>\t\tC')).toBe('A B C')
  })

  it('白名单实体解码：命名 + 数字 + 十六进制', () => {
    expect(htmlToText('<p>a&amp;b</p>')).toBe('a&b')
    expect(htmlToText('<p>&lt;div&gt; &quot;q&quot; &#x27;s&#39;</p>')).toBe('<div> "q" \'s\'')
    expect(htmlToText('<p>x&nbsp;y</p>')).toBe('x y')
    expect(htmlToText('<p>&copy; 2026</p>')).toBe('© 2026')
    expect(htmlToText('&#65;&#x42;')).toBe('AB')
  })

  it('单遍解码防双重转义：&amp;lt; 解为字面 &lt; 文本而非 <', () => {
    expect(htmlToText('&amp;lt;')).toBe('&lt;')
  })

  it('越界数字实体原样保留；空输入返回空串', () => {
    expect(htmlToText('&#1114112;')).toBe('&#1114112;')
    expect(htmlToText('')).toBe('')
  })
})

describe('extractReadable（可读性启发式）', () => {
  it('article 容器优先于零散段落簇（最长候选胜出）', () => {
    const long = Array.from(
      { length: 8 },
      (_, i) => `<p>文章主体第${i}段，长度足够参与密度聚簇。</p>`,
    ).join('')
    const html = `<header>站头</header><article>${long}</article><aside><p>侧栏</p></aside>`
    const readable = extractReadable(html)
    expect(readable).toContain('文章主体第0段')
    expect(readable).not.toContain('侧栏')
  })

  it('无 article/main 时回退全文 <p> 簇，过滤低于密度门槛的短段', () => {
    const html = '<p>ok</p><p>这一段足够长，会被视作正文段落保留下来。</p>'
    const readable = extractReadable(html)
    expect(readable).toContain('足够长')
    expect(readable).not.toBe('')
    expect(readable.startsWith('ok')).toBe(false)
  })

  it('main 容器与纯 div 噪声页面', () => {
    expect(extractReadable('<main><p>主容器内的正文内容，密度达标无误。</p></main>')).toContain(
      '主容器',
    )
    expect(extractReadable('<div>只有噪声没有段落</div>')).toBe('')
  })
})

describe('renderExtract（渲染回退链）', () => {
  const SOURCE = 'https://example.com/doc'
  const rich = `<html><body><article><p>${'主'.repeat(40)}内容段落。</p></article></body></html>`

  it('raw 模式输出全文纯文本，mode 原样写回', () => {
    const out = renderExtract(rich, 'raw', SOURCE, 10_000)
    expect(out.mode).toBe('raw')
    expect(out.text.startsWith('主')).toBe(true)
    expect(out.truncated).toBe(false)
  })

  it('fit 模式输出可读性抽取结果', () => {
    const out = renderExtract(rich, 'fit', SOURCE, 10_000)
    expect(out.mode).toBe('fit')
    expect(out.text.endsWith('内容段落。')).toBe(true)
  })

  it('citations 模式 = readable 首 500 字符 + 来源行', () => {
    const longArticle = `<article><p>${'很长的正文。'.repeat(200)}</p></article>`
    const out = renderExtract(longArticle, 'citations', SOURCE, 100_000)
    expect(out.mode).toBe('citations')
    expect(out.text).toContain(`\n来源: ${SOURCE}`)
    expect(out.text.indexOf('\n来源:')).toBe(CITATION_HEAD_CHARS)
    expect(out.truncated).toBe(true)
  })

  it('首选模式抽空时按 raw→fit 找有内容者胜，实际 mode 写回', () => {
    const divOnly = '<div>仅有的可见文字</div>'
    const fitFirst = renderExtract(divOnly, 'fit', SOURCE, 10_000)
    expect(fitFirst.mode).toBe('raw')
    expect(fitFirst.text).toBe('仅有的可见文字')

    const citeFallback = renderExtract(divOnly, 'citations', SOURCE, 10_000)
    expect(citeFallback.mode).toBe('raw')
    expect(citeFallback.text).toBe('仅有的可见文字')
  })

  it('citations 在 readable 非空时不回退（头部 + 来源行即产出）', () => {
    const out = renderExtract(rich, 'citations', SOURCE, 100_000)
    expect(out.mode).toBe('citations')
    expect(out.text).toContain(`\n来源: ${SOURCE}`)
  })

  it('maxChars 统一裁剪并置 truncated；全空输入返回空串交由管线兜底', () => {
    const out = renderExtract(rich, 'raw', SOURCE, 10)
    expect(out.text.length).toBe(10)
    expect(out.truncated).toBe(true)

    const empty = renderExtract('', 'fit', SOURCE, 100)
    expect(empty.text).toBe('')
    expect(empty.mode).toBe('fit')
    expect(empty.truncated).toBe(false)
  })
})
