/**
 * 正文抽取：HTML → 纯文本 + 可读性启发式 + 渲染回退链（F-004）。
 *
 * 设计要点：
 * - 零依赖手写启发式：不引入 DOM 解析器，正则分阶段处理（去噪 → 块转换 →
 *   去标签 → 实体解码 → 压空白），顺序保证 `&lt;script&gt;` 这类文本形态
 *   不会被误当标签剔除（实体解码永远在去标签之后，且单遍替换防双重解码）。
 * - 回退链「有 URL 就有产出」（W-B-96）：首选模式抽空时按 raw→fit 找
 *   「有内容者胜」，实际达成的模式写回给调用方降级渲染。
 *
 * @module webstack/fetch/extract
 */

import type { FetchMode } from '../kernel/types.ts'

/** 抽取模式回退链顺序（契约冻结：先声明者优先）。 */
export const EXTRACT_FALLBACK_CHAIN: readonly FetchMode[] = Object.freeze([
  'raw',
  'fit',
  'citations',
])

/** citations 模式的正文头部保留字符数（来源行不计入该配额）。 */
export const CITATION_HEAD_CHARS = 500

/** 可读性启发式的段落密度门槛：短于此的 <p> 视为噪声（按钮/导航残渣）。 */
const PARAGRAPH_DENSITY_MIN = 16

/**
 * 单遍解码白名单 HTML 实体（&amp;&lt;&gt;&quot;&#x27;&nbsp;&copy; + 十进制/
 * 十六进制数字实体）。单遍替换避免 `&amp;lt;` 类双重解码把用户内容误当转义
 * 序列（解码输出不再二次扫描）；越界数字实体原样保留匹配文本。
 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|#x27|nbsp|copy|#\d+|#x[0-9a-fA-F]+);/g,
    (raw, name: string) => {
      switch (name) {
        case 'amp':
          return '&'
        case 'lt':
          return '<'
        case 'gt':
          return '>'
        case 'quot':
          return '"'
        case '#x27':
          return "'"
        case 'nbsp':
          return ' '
        case 'copy':
          return '©'
        default:
          break
      }
      // 数字实体（&#65; / &#x42;）：越界或落在代理区时放弃解码、原样保留。
      const codePoint = name.startsWith('#x')
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10)
      if (
        !Number.isInteger(codePoint) ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return raw
      }
      return String.fromCodePoint(codePoint)
    },
  )
}

/** HTML 噪声块（script/style/nav/footer/header 与注释）整块剔除。 */
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
}

/** 把 HTML 片段转纯文本：块级标签转换行、其余标签剔除、实体解码、压空白。 */
export function htmlToText(html: string): string {
  const flattened = stripNoise(html)
    .replace(/<\/?(br|p|div|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(flattened)
    .replace(/[^\S\n]+/g, ' ') // 水平空白（含 &nbsp; 解码产物）压成单空格
    .replace(/ *\n\s*/g, '\n') // 换行两侧的残余空白收掉
    .replace(/\n{2,}/g, '\n') // 连续块级标签只留一个换行
    .trim()
}

/** 收集某容器标签的首个块内 HTML；不存在返回 undefined。 */
function firstBlock(html: string, tag: 'article' | 'main'): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i')
  const m = re.exec(html)
  return m === null ? undefined : (m[1] ?? '')
}

/**
 * 可读性启发式主内容抽取：收集 `<article>` / `<main>` 容器全文与全文
 * `<p>` 段落簇（过滤低于密度门槛的短段），按长度取最大簇——正文所在的
 * 容器几乎总是最长的那个候选。无任何候选命中时返回空串（交给回退链）。
 */
export function extractReadable(html: string): string {
  const candidates: string[] = []
  for (const tag of ['article', 'main'] as const) {
    const inner = firstBlock(html, tag)
    if (inner !== undefined) {
      const text = htmlToText(inner)
      if (text.length > 0) candidates.push(text)
    }
  }
  const paragraphs: string[] = []
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const text = htmlToText(m[1] ?? '')
    if (text.length >= PARAGRAPH_DENSITY_MIN) paragraphs.push(text)
  }
  if (paragraphs.length > 0) candidates.push(paragraphs.join('\n'))
  let best = ''
  for (const candidate of candidates) {
    if (candidate.length > best.length) best = candidate
  }
  return best
}

/** renderExtract 的产出：text 为最终视图，mode 为实际达成模式，truncated 截断标记。 */
export interface RenderOutcome {
  readonly text: string
  readonly mode: FetchMode
  readonly truncated: boolean
}

/** 按 mode 生成候选视图；citations = readable 头部 + 来源行（W-B-96 引用视图）。 */
function attemptRender(
  html: string,
  mode: FetchMode,
  sourceUrl: string,
): { text: string; clipped: boolean } {
  if (mode === 'raw') return { text: htmlToText(html), clipped: false }
  const readable = extractReadable(html)
  if (mode === 'fit') return { text: readable, clipped: false }
  // citations：readable 首 CITATION_HEAD_CHARS 字符 + 「来源: URL」行。
  const line = `\n来源: ${sourceUrl}`
  if (readable.length === 0) return { text: '', clipped: false }
  const clipped = readable.length > CITATION_HEAD_CHARS
  return { text: `${readable.slice(0, CITATION_HEAD_CHARS)}${line}`, clipped }
}

/**
 * 渲染抽取入口：先按请求 mode 出图；结果为空则沿 raw→fit 找「有内容者胜」，
 * 实际达成的 mode 写回；最后统一按 maxChars 裁剪并置 truncated。
 * 全链路皆空时返回空串（由管线注入解释性文案，绝不静默空白上呈）。
 */
export function renderExtract(
  html: string,
  mode: FetchMode,
  sourceUrl: string,
  maxChars: number,
): RenderOutcome {
  let achieved = mode
  let result = attemptRender(html, achieved, sourceUrl)
  let truncated = result.clipped
  if (result.text.length === 0 && achieved !== 'raw') {
    const rawAttempt = attemptRender(html, 'raw', sourceUrl)
    if (rawAttempt.text.length > 0) {
      achieved = 'raw'
      result = rawAttempt
    }
  }
  if (result.text.length === 0 && achieved !== 'fit') {
    const fitAttempt = attemptRender(html, 'fit', sourceUrl)
    if (fitAttempt.text.length > 0) {
      achieved = 'fit'
      result = fitAttempt
    }
  }
  let text = result.text
  if (text.length > maxChars) {
    text = text.slice(0, Math.max(0, maxChars))
    truncated = true
  }
  return { text, mode: achieved, truncated }
}
