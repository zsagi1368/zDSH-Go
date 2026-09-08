/** 站选选择器规则引擎离线测试：后缀匹配 / 子集语法命中与拒绝 / 预算截断。 */
import { describe, expect, it } from 'vitest'
import { applySelectorRules, matchRule } from '../src/fetch/selectors.ts'
import type { ContentBudgets, SelectorRule } from '../src/kernel/types.ts'

const BUDGETS: ContentBudgets = {
  canonicalChars: 4096,
  renderedChars: 4096,
  errorChars: 512,
}

function rule(selectors: SelectorRule['selectors'], hostSuffix = 'example.com'): SelectorRule {
  return { hostSuffix, selectors }
}

describe('matchRule 最长后缀匹配', () => {
  const rules: readonly SelectorRule[] = [
    rule({ content: 'div.a' }, 'example.com'),
    rule({ content: 'div.b' }, 'docs.example.com'),
    rule({ content: 'div.c' }, 'com'),
  ]

  it('精确命中与子域命中；点边界约束拒绝伪后缀', () => {
    expect(matchRule(rules, 'example.com')?.selectors.content).toBe('div.a')
    expect(matchRule(rules, 'a.b.example.com')?.selectors.content).toBe('div.a')
    expect(matchRule(rules, 'DOCS.example.com.')?.selectors.content).toBe('div.b')
    // notexample.com 不因「以 com 结尾」或字符串 endsWith 误命中 example.com。
    expect(matchRule(rules, 'notexample.com')?.selectors.content).toBe('div.c')
    expect(matchRule(rules, 'notexample.com')?.hostSuffix).toBe('com')
    expect(matchRule(rules, 'evilexample.com')?.hostSuffix).toBe('com')
  })

  it('最长后缀优先于更短后缀；空表/空 host/空后缀安全返回', () => {
    const two: readonly SelectorRule[] = [
      rule({ content: 'x' }, 'com'),
      rule({ content: 'y' }, 'a.example.com'),
    ]
    expect(matchRule(two, 'a.example.com')?.selectors.content).toBe('y')
    expect(matchRule([], 'example.com')).toBeUndefined()
    expect(matchRule(rules, '')).toBeUndefined()
    const blankSuffix: readonly SelectorRule[] = [rule({ content: 'z' }, '')]
    expect(matchRule(blankSuffix, 'example.com')).toBeUndefined()
  })

  it('同长度并列取先声明者；带端口/大小写形态经规整后仍命中', () => {
    const tie: readonly SelectorRule[] = [
      rule({ content: 'first' }, 'example.com'),
      rule({ content: 'second' }, 'EXAMPLE.com'),
    ]
    expect(matchRule(tie, 'www.example.com')?.selectors.content).toBe('first')
  })
})

describe('applySelectorRules 选择器命中', () => {
  const DOC = `
    <html><head><title>站点标题</title></head>
    <body>
      <nav>导航噪声</nav>
      <article class="post" data-kind="tech">
        <h1 class="headline">规则命中的标题</h1>
        <div id="body"><p>第一段正文内容，足够长以参与抽取。</p><p>第二段正文。</p></div>
        <img src="x.png"><br>
      </article>
      <footer>页脚</footer>
    </body></html>`

  it('tag/.class/#id/[attr=value] 复合单元命中；title/content 双通道产出', () => {
    const out = applySelectorRules(
      DOC,
      rule({ title: 'h1.headline', content: 'article[data-kind=tech] #body' }),
      BUDGETS,
    )
    expect(out.title).toBe('规则命中的标题')
    expect(out.content).toContain('第一段正文内容')
    expect(out.content).toContain('第二段正文')
    expect(out.truncated).toBe(false)
  })

  it('后代组合器与 > 直接子代组合器语义正确', () => {
    const descendant = applySelectorRules(DOC, rule({ content: 'article p' }), BUDGETS)
    expect(descendant.content).toContain('第一段正文')
    const childOnly = applySelectorRules(DOC, rule({ content: 'body > p' }), BUDGETS)
    expect(childOnly.content).toBe('')
    const childHit = applySelectorRules(DOC, rule({ content: 'article > div > p' }), BUDGETS)
    expect(childHit.content).toContain('第一段正文') // 文档序首个命中元素
  })

  it('逗号分组按声明顺序取首个命中组；属性双引号/单引号/裸词三形态等价', () => {
    const multi = applySelectorRules(
      '<main><section data-a="1">首选分组文本</section><p>兜底分组文本</p></main>',
      rule({ content: 'section[data-a="1"], p' }),
      BUDGETS,
    )
    expect(multi.content).toBe('首选分组文本')
    const swapped = applySelectorRules(
      '<main><section data-a="1">首选分组文本</section><p>兜底分组文本</p></main>',
      rule({ content: 'p, section[data-a=1]' }),
      BUDGETS,
    )
    expect(swapped.content).toBe('兜底分组文本')
    const quoted = applySelectorRules(
      '<section data-a=\'2\'>单引号命中</section><section data-b="b">双引号</section>',
      rule({ content: 'section[data-a=\'2\'], section[data-b="b"]' }),
      BUDGETS,
    )
    expect(quoted.content).toBe('单引号命中')
  })

  it('void 元素/注释/错误嵌套不破坏建树；script 噪声被剔除', () => {
    const messy =
      '<div id="c"><!-- 注释 <div> --><p>正文<script>evil()</script>继续<br/>收尾</p></div>'
    const out = applySelectorRules(messy, rule({ content: '#c' }), BUDGETS)
    expect(out.content).toContain('正文')
    expect(out.content).toContain('继续')
    expect(out.content).toContain('收尾')
    expect(out.content).not.toContain('evil')
    expect(out.content).not.toContain('注释')
  })
})

describe('applySelectorRules 未命中与语法拒绝（回退默认管线的入口条件）', () => {
  it('元素不存在 → 空内容；title 抽空但 content 命中时 title 缺席', () => {
    const miss = applySelectorRules('<div><p>x</p></div>', rule({ content: '.missing' }), BUDGETS)
    expect(miss.content).toBe('')
    const noTitle = applySelectorRules(
      '<div class="c"><p>只有正文</p></div>',
      rule({ title: '.no-such-title', content: 'div.c' }),
      BUDGETS,
    )
    expect(noTitle.content).toBe('只有正文')
    expect('title' in noTitle).toBe(false)
  })

  it('子集外语法（伪类/兄弟组合器/未闭合括号/裸存在属性）一律按未命中处理且绝不抛错', () => {
    const samples = [
      'div:hover',
      'h1 + p',
      'div ~ span',
      'a[href]',
      '[data-x',
      '',
      '   ',
      'div::before',
      'li:nth-child(2)',
      'a[href^="http"]',
    ]
    for (const selector of samples) {
      const out = applySelectorRules(
        '<div class="w"><p>内容</p></div>',
        rule({ content: selector }),
        BUDGETS,
      )
      expect(out.content).toBe('')
      expect(out.truncated).toBe(false)
    }
  })

  it('非法 HTML 输入（空串/纯文本）安全返回空内容，不抛错', () => {
    expect(applySelectorRules('', rule({ content: 'div' }), BUDGETS).content).toBe('')
    expect(applySelectorRules('plain text only', rule({ content: 'div' }), BUDGETS).content).toBe(
      '',
    )
  })
})

describe('applySelectorRules budgets 截断', () => {
  it('content 超 renderedChars 截断并置 truncated；title 受 errorChars 约束', () => {
    const html = `<article><h2>${'标'.repeat(40)}</h2><p>${'正'.repeat(200)}</p></article>`
    const tight: ContentBudgets = { canonicalChars: 4096, renderedChars: 50, errorChars: 10 }
    const out = applySelectorRules(html, rule({ title: 'h2', content: 'article p' }), tight)
    expect(out.content.length).toBe(50)
    expect(out.truncated).toBe(true)
    expect(out.title?.length).toBe(10)
  })

  it('恰好在预算边界内不置 truncated', () => {
    const html = `<p>${'恰好五十'.repeat(13)}</p>` // 52 字符
    const budgets: ContentBudgets = { canonicalChars: 4096, renderedChars: 52, errorChars: 512 }
    const out = applySelectorRules(html, rule({ content: 'p' }), budgets)
    expect(out.content.length).toBe(52)
    expect(out.truncated).toBe(false)
  })
})
