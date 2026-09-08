/**
 * 站选定制源选择器规则引擎（F-203 / pro B-11）。
 *
 * 职责两件事：
 * 1. `matchRule`：hostname 最长后缀匹配——`example.com` 命中 `a.b.example.com`
 *    但绝不命中 `notexample.com`（点边界约束）；同长度并列取先声明者。
 * 2. `applySelectorRules`：按命中规则的 CSS 选择器子集抽取 title/content，
 *    budgets 截断后返回；任何失败（语法不支持/未命中/抽空）一律返回空内容
 *    让调用方落回默认抽取管线，绝不抛错、绝不 eval。
 *
 * 选择器子集语法（自写轻量匹配器，原创实现，零依赖零 DOM）：
 * - 简单选择器单元：`tag` / `*` / `.class` / `#id` / `[attr=value]`
 *   （value 支持双引号、单引号或裸词三种形态，属性名大小写不敏感）；
 * - 组合器：后代（空白）与直接子代（`>`），逗号分组先声明者优先；
 * - 明确拒绝集：伪类/伪元素、通配属性、兄弟组合器、转义序列等一律解析
 *   失败按「未命中」处理——语法面即安全面，不存在注入路径。
 *
 * @module webstack/fetch/selectors
 */

import type { ContentBudgets, SelectorRule } from '../kernel/types.ts'
import { htmlToText } from './extract.ts'

// ---------------------------------------------------------------------------
// matchRule：hostname 最长后缀匹配
// ---------------------------------------------------------------------------

/** 规整 host：小写、去尾部点（FQDN 尾点容忍）。 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '')
}

/**
 * 最长后缀匹配：返回命中的第一条规则（后缀最长者优先，等长取先声明者）。
 * 后缀必须整体落在点边界上——`example.com` 命中 `a.b.example.com` 与
 * `example.com` 本身，但不命中 `notexample.com`。host 为空永不匹配。
 */
export function matchRule(rules: readonly SelectorRule[], host: string): SelectorRule | undefined {
  const target = normalizeHost(host)
  if (target === '') return undefined
  let best: SelectorRule | undefined
  let bestLen = -1
  for (const rule of rules) {
    const suffix = normalizeHost(rule.hostSuffix)
    if (suffix === '') continue
    const matched = target === suffix || target.endsWith(`.${suffix}`)
    if (matched && suffix.length > bestLen) {
      best = rule
      bestLen = suffix.length
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// 选择器子集解析器（纯函数，失败返回 undefined）
// ---------------------------------------------------------------------------

type SimpleUnit =
  | { readonly kind: 'tag'; readonly name: string }
  | { readonly kind: 'class'; readonly name: string }
  | { readonly kind: 'id'; readonly name: string }
  | { readonly kind: 'attr'; readonly name: string; readonly value: string }

/** 复合选择器：若干简单单元的与组合（如 `div.card#main[data-kind=post]`）。 */
type Compound = readonly SimpleUnit[]

/**
 * 组内一个环节。`combinator` 描述本环节与**前一环节**的关系：
 * `none` 仅首环节使用。
 */
interface Part {
  readonly combinator: 'none' | 'descendant' | 'child'
  readonly compound: Compound
}

/** 逗号分组后的完整选择器（组间先声明者优先）。 */
type SelectorGroups = readonly (readonly Part[])[]

const UNIT_NAME_RE = /^[A-Za-z0-9_-]+/
const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*/
const ATTR_NAME_RE = /^[A-Za-z_:][-A-Za-z0-9_:.]*/

/**
 * 解析 CSS 选择器子集；任何超出子集的语法（伪类、兄弟组合器、空选择器、
 * 未闭合括号等）一律返回 undefined（= 未命中语义，绝不近似猜测）。
 */
function parseSelectorGroups(raw: string): SelectorGroups | undefined {
  const source = raw.trim()
  if (source === '') return undefined
  const groups: (readonly Part[])[] = []
  let curParts: Part[] = []
  let curUnits: SimpleUnit[] = []
  let pendingComb: 'descendant' | 'child' = 'descendant'
  let i = 0

  const closeCompound = (): void => {
    if (curUnits.length === 0) return
    curParts.push({
      combinator: curParts.length === 0 ? 'none' : pendingComb,
      compound: curUnits,
    })
    curUnits = []
    pendingComb = 'descendant'
  }
  const closeGroup = (): boolean => {
    closeCompound()
    if (curParts.length === 0) return false
    groups.push(curParts)
    curParts = []
    return true
  }

  while (i < source.length) {
    const ch = source[i]
    if (ch === undefined) break
    if (/\s/.test(ch)) {
      closeCompound()
      i += 1
      continue
    }
    if (ch === '>') {
      closeCompound()
      // `>` 必须跟在已有复合之后，否则语法非法。
      if (curParts.length === 0) return undefined
      pendingComb = 'child'
      i += 1
      continue
    }
    if (ch === ',') {
      if (!closeGroup()) return undefined
      pendingComb = 'descendant'
      i += 1
      continue
    }
    if (ch === '.') {
      const m = UNIT_NAME_RE.exec(source.slice(i + 1))
      if (m === null || m[0] === '') return undefined
      curUnits.push({ kind: 'class', name: m[0] })
      i += 1 + m[0].length
      continue
    }
    if (ch === '#') {
      const m = UNIT_NAME_RE.exec(source.slice(i + 1))
      if (m === null || m[0] === '') return undefined
      curUnits.push({ kind: 'id', name: m[0] })
      i += 1 + m[0].length
      continue
    }
    if (ch === '[') {
      const parsed = parseAttrUnit(source, i + 1)
      if (parsed === undefined) return undefined
      curUnits.push(parsed.unit)
      i = parsed.next
      continue
    }
    // 标签名只允许出现在复合开头（CSS 简单选择器序约定）。
    if (curUnits.length === 0) {
      if (ch === '*') {
        curUnits.push({ kind: 'tag', name: '*' })
        i += 1
        continue
      }
      const m = TAG_NAME_RE.exec(source.slice(i))
      if (m === null) return undefined
      curUnits.push({ kind: 'tag', name: m[0].toLowerCase() })
      i += m[0].length
      continue
    }
    return undefined // 其余字符一律不在子集内
  }
  if (!closeGroup()) return undefined
  return groups
}

/** 解析 `[attr=value]` 单元（入口跳过 `[`）；失败返回 undefined。 */
function parseAttrUnit(
  source: string,
  start: number,
): { unit: SimpleUnit; next: number } | undefined {
  let j = start
  const nameM = ATTR_NAME_RE.exec(source.slice(j))
  if (nameM === null) return undefined
  const name = nameM[0].toLowerCase()
  j += nameM[0].length
  while (j < source.length && /\s/.test(source[j] ?? '')) j += 1
  if (source[j] !== '=') return undefined // 只支持存在+相等判定，不支持裸存在/前缀匹配
  j += 1
  while (j < source.length && /\s/.test(source[j] ?? '')) j += 1
  const quote = source[j]
  let value: string
  if (quote === '"' || quote === "'") {
    const end = source.indexOf(quote, j + 1)
    if (end === -1) return undefined
    value = source.slice(j + 1, end)
    j = end + 1
  } else {
    const rest = source.slice(j)
    const m = /^[^\]\s]+/.exec(rest)
    if (m === null) return undefined
    value = m[0]
    j += m[0].length
  }
  while (j < source.length && /\s/.test(source[j] ?? '')) j += 1
  if (source[j] !== ']') return undefined
  return { unit: { kind: 'attr', name, value }, next: j + 1 }
}

// ---------------------------------------------------------------------------
// 轻量元素树（无 DOM 依赖的正则事件流建树）
// ---------------------------------------------------------------------------

interface MiniElement {
  readonly tag: string
  readonly attrs: Readonly<Record<string, string>>
  readonly classes: readonly string[]
  readonly id: string | undefined
  parent: MiniElement | undefined
  readonly children: MiniElement[]
  /** 元素 inner 内容在原文中的 [start, end) 偏移。 */
  innerStart: number
  innerEnd: number
}

const VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** 建树深度上限：防御病态深嵌套文档（超出深度的元素拍平挂当前层）。 */
const MAX_TREE_DEPTH = 400

const OPEN_TAG_RE = /<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/y
const CLOSE_TAG_RE = /<\/\s*([A-Za-z][A-Za-z0-9:-]*)\s*>/y
const COMMENT_END = '-->'
const ATTR_SCAN_RE =
  /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=>]+)))?/g

/** 解析开标签属性串为小写键记录（值保持原样；重复键首见优先）。 */
function parseAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let body = text
  if (body.trimEnd().endsWith('/')) body = body.trimEnd().slice(0, -1) // 自闭合格式容忍
  ATTR_SCAN_RE.lastIndex = 0
  for (;;) {
    const m = ATTR_SCAN_RE.exec(body)
    if (m === null) break
    const name = (m[1] ?? '').toLowerCase()
    if (name === '') continue
    // 双引号 / 单引号 / 裸词三选一；无等号的布尔属性记空串。
    const value = m[2] ?? m[3] ?? m[4]
    out[name] = value ?? ''
  }
  return out
}

/**
 * 把 HTML 解析成以 `root` 为虚拟根的元素树。容错姿态与 extract 同款：
 * 注释剔除、void 元素不入栈、自闭合格式立即闭合、错误嵌套就近配对回弹、
 * 未闭合标签在 EOF 统一收口。绝不抛错。
 */
function buildForest(html: string, root: MiniElement): void {
  const stack: MiniElement[] = []
  const parentOf = (): MiniElement => stack[stack.length - 1] ?? root
  const el = (tag: string, attrs: Record<string, string>, innerStart: number): MiniElement => ({
    tag,
    attrs,
    classes: (attrs.class ?? '').split(/\s+/).filter(c => c !== ''),
    id: attrs.id,
    parent: stack[stack.length - 1],
    children: [],
    innerStart,
    innerEnd: html.length,
  })

  let i = 0
  for (;;) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf(COMMENT_END, lt + 4)
      i = end === -1 ? html.length : end + COMMENT_END.length
      continue
    }
    CLOSE_TAG_RE.lastIndex = lt
    const closeM = html[lt + 1] === '/' ? CLOSE_TAG_RE.exec(html) : null
    if (closeM !== null) {
      const tag = (closeM[1] ?? '').toLowerCase()
      let hit = -1
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k]?.tag === tag) {
          hit = k
          break
        }
      }
      if (hit >= 0) {
        for (let k = stack.length - 1; k >= hit; k -= 1) {
          const node = stack[k]
          if (node !== undefined) node.innerEnd = lt
        }
        stack.length = hit
      }
      i = CLOSE_TAG_RE.lastIndex
      continue
    }
    OPEN_TAG_RE.lastIndex = lt
    const openM = OPEN_TAG_RE.exec(html)
    if (openM === null) {
      i = lt + 1 // 游离 `<` 按字面文本处理
      continue
    }
    const tag = (openM[1] ?? '').toLowerCase()
    const attrs = parseAttrs(openM[2] ?? '')
    const selfClosing = (openM[2] ?? '').trimEnd().endsWith('/')
    const node = el(tag, attrs, OPEN_TAG_RE.lastIndex)
    parentOf().children.push(node)
    if (!selfClosing && !VOID_TAGS.has(tag) && stack.length < MAX_TREE_DEPTH) {
      stack.push(node)
    }
    i = OPEN_TAG_RE.lastIndex
  }
  // EOF 收口：仍在栈上的元素 innerEnd 已是 html.length（构造缺省）。
}

// ---------------------------------------------------------------------------
// 匹配与抽取
// ---------------------------------------------------------------------------

/** 判定元素是否满足单个复合选择器。 */
function matchCompound(el: MiniElement, compound: Compound): boolean {
  for (const unit of compound) {
    switch (unit.kind) {
      case 'tag':
        if (el.tag !== unit.name) return false
        break
      case 'class':
        if (!el.classes.includes(unit.name)) return false
        break
      case 'id':
        if (el.id !== unit.name) return false
        break
      case 'attr':
        if ((el.attrs[unit.name] ?? undefined) !== unit.value) return false
        break
    }
  }
  return true
}

/** 右到左校验环节链（parts[idx] 相对 parts[idx-1] 的关系由其 combinator 表达）。 */
function matchChain(el: MiniElement, parts: readonly Part[], idx: number): boolean {
  const part = parts[idx]
  if (part === undefined || !matchCompound(el, part.compound)) return false
  if (idx === 0) return true
  if (part.combinator === 'child') {
    const parent = el.parent
    return parent !== undefined ? matchChain(parent, parts, idx - 1) : false
  }
  for (let anc = el.parent; anc !== undefined; anc = anc.parent) {
    if (matchChain(anc, parts, idx - 1)) return true
  }
  return false
}

/** 先序遍历收集虚拟根之下的全部真实元素。 */
function collectElements(node: MiniElement, out: MiniElement[]): void {
  for (const child of node.children) {
    out.push(child)
    collectElements(child, out)
  }
}

/**
 * 按逗号分组依序找首个命中元素的 inner 文本；全组未命中或解析失败返回空串。
 */
function queryFirstText(html: string, root: MiniElement, selector: string): string {
  const groups = parseSelectorGroups(selector)
  if (groups === undefined) return ''
  const all: MiniElement[] = []
  collectElements(root, all)
  for (const parts of groups) {
    for (const el of all) {
      if (matchChain(el, parts, parts.length - 1)) {
        const text = htmlToText(html.slice(el.innerStart, el.innerEnd))
        if (text !== '') return text
      }
    }
  }
  return ''
}

/** 规则抽取产出（title 缺席 = 规则未声明或未抽到）。 */
export interface SelectorExtractOutcome {
  readonly title?: string
  readonly content: string
  readonly truncated: boolean
}

/**
 * 按命中规则抽取 title/content。预算纪律：content 以 renderedChars 为上限、
 * title 以 errorChars 为上限，越界截断并置 truncated。任何一步拿不到产出
 * 都以 `content: ''` 收场（调用方据此落回默认抽取管线），绝不抛错。
 */
export function applySelectorRules(
  html: string,
  rule: SelectorRule,
  budgets: ContentBudgets,
): SelectorExtractOutcome {
  const root: MiniElement = {
    tag: '#root',
    attrs: {},
    classes: [],
    id: undefined,
    parent: undefined,
    children: [],
    innerStart: 0,
    innerEnd: html.length,
  }
  try {
    buildForest(html, root)
    const contentRaw = queryFirstText(html, root, rule.selectors.content)
    const clipped = clipTo(contentRaw, budgets.renderedChars)
    const titleSel = rule.selectors.title
    if (titleSel === undefined || clipped.text === '') {
      return clipped.text === ''
        ? { content: '', truncated: false }
        : { content: clipped.text, truncated: clipped.truncated }
    }
    const titleClipped = clipTo(queryFirstText(html, root, titleSel), budgets.errorChars)
    return {
      ...(titleClipped.text === '' ? {} : { title: titleClipped.text }),
      content: clipped.text,
      truncated: clipped.truncated || titleClipped.truncated,
    }
  } catch {
    // 防御性兜底：任何意外输入都不得让规则抽取变成致命路径。
    return { content: '', truncated: false }
  }
}

/** 上限裁剪工具：越界截断并置标记。 */
function clipTo(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, Math.max(0, maxChars)), truncated: true }
}
