/**
 * FileHub bilingual dictionary (P01 §6-E FR-E5'): every M5 UI string lives
 * here — zh/en key sets MUST stay identical (asserted by tests/client/
 * i18n.test.ts). Pure module: no DOM, no React, no host imports, so the
 * dictionary round-trips through unit tests untouched.
 *
 * Language signal strategy:
 * - default: navigator detection via util.detectLang (same rule as M1);
 * - host integration: when the composition ships @deepseek-ai/dsh-client-locale,
 *   index.tsx hands the verified LocaleRuntime subset to bindHostLocale() so
 *   switches follow the user's language preference live. Evidence:
 *   Fork/packages/client/locale/lib/types/client/index.d.ts declares
 *   `locale: LocaleRuntime` on the cordis Context (declare-module block),
 *   with getLocale(): LocaleSnapshot (~line 74), subscribe(fn) (~line 86) and
 *   an untyped register/bind pair for namespaces outside the merge table
 *   (~lines 157/172). We consume only getLocale+subscribe — registering a
 *   namespace would collide with first-party owners, and reading the active id
 *   is enough. A bare context without the plugin simply skips the bind (the
 *   `typeof face.getLocale === 'function'` guard) and keeps the navigator
 *   fallback.
 */

import { detectLang } from './util.js'
import type { Lang } from './util.js'

const ZH: Record<string, string> = {
  // ---- Upload dock (M4 vision badge) ----------------------------------------
  'dock.explained': '已讲解',

  // ---- Console (conversation.view tab) -------------------------------------
  'console.tab': '文件',
  'console.title': '文件中心',
  'console.search.placeholder': '搜索文件名或路径…',
  'console.filter.all': '全部',
  'console.filter.image': '图片',
  'console.filter.document': '文档',
  'console.filter.text': '文本',
  'console.filter.binary': '二进制',
  'console.filter.media': '音视频',
  'console.stats.summary': '{files} 个文件 · {size}',
  'console.empty': '没有匹配的文件',
  'console.loading': '加载中…',
  'console.retry': '重试',
  'console.refresh': '刷新',
  'console.truncated': '结果过多，仅显示前 {limit} 条',
  'console.disabled': 'FileHub 已在设置中停用',
  'console.error.load': '加载失败：{message}',
  'console.detail.path': '路径',
  'console.detail.copy': '复制路径',
  'console.detail.copied': '已复制',
  'console.detail.session': '会话',
  'console.detail.size': '大小',
  'console.detail.time': '时间',
  'console.detail.kind': '类型',
  'console.cleanup.expired': '清理过期文件',
  'console.cleanup.session': '清空本会话文件',
  'console.cleanup.confirmTitle': '确认清理',
  'console.cleanup.dryRun': '将删除 {count} 个文件，释放 {size}。',
  'console.cleanup.execute': '确认删除',
  'console.cleanup.cancel': '取消',
  'console.cleanup.working': '处理中…',
  'console.cleanup.done': '已删除 {count} 个文件，释放 {size}',
  'console.cleanup.failed': '清理失败：{message}',

  // ---- Settings (settings.plugins.tab) --------------------------------------
  'settings.tab': 'FileHub',
  'settings.section.general': '通用',
  'settings.section.privacy': '隐私',
  'settings.enabled': '启用 FileHub',
  'settings.enabled.desc': '关闭后控制台与上传入口一并隐藏。',
  'settings.ignorePastedMentions': '忽略粘贴内容的 @ 候选',
  'settings.ignorePastedMentions.desc': '粘贴文本中的路径不再生成文件引用候选。',
  'settings.candidatesMax': '候选数量上限',
  'settings.candidatesMax.desc': '@ 提及选择器一次展示的最大条数（1–200）。',
  'settings.defaultView': '控制台默认视图',
  'settings.defaultView.desc': '打开“文件”标签页时的分组方式。',
  'settings.defaultView.grouped': '按会话分组',
  'settings.defaultView.flat': '平铺列表',
  'settings.localFirstVision': '本地优先展示图片',
  'settings.localFirstVision.desc': '先展示本地缩略与说明，外发请求带横幅标记读取。',
  'settings.visionMode': '图像理解模式',
  'settings.visionMode.desc': '控制视觉瀑布流对外发送图像的策略。',
  'settings.visionMode.off': '关闭',
  'settings.visionMode.caption': '仅生成说明',
  'settings.visionMode.analyze': '完整分析',
  'settings.restoreDefaults': '恢复默认设置',
  'settings.restoreConfirm': '确定恢复全部默认值吗？',
  'settings.saved': '已保存',
  'settings.saveError': '保存失败：{message}',
  'settings.loading': '加载中…',
}

const EN: Record<string, string> = {
  // ---- Upload dock (M4 vision badge) ----------------------------------------
  'dock.explained': 'Explained',

  // ---- Console --------------------------------------------------------------
  'console.tab': 'Files',
  'console.title': 'File center',
  'console.search.placeholder': 'Search file name or path…',
  'console.filter.all': 'All',
  'console.filter.image': 'Images',
  'console.filter.document': 'Documents',
  'console.filter.text': 'Text',
  'console.filter.binary': 'Binary',
  'console.filter.media': 'Media',
  'console.stats.summary': '{files} files · {size}',
  'console.empty': 'No matching files',
  'console.loading': 'Loading…',
  'console.retry': 'Retry',
  'console.refresh': 'Refresh',
  'console.truncated': 'Too many results — showing the first {limit}',
  'console.disabled': 'FileHub is disabled in Settings',
  'console.error.load': 'Failed to load: {message}',
  'console.detail.path': 'Path',
  'console.detail.copy': 'Copy path',
  'console.detail.copied': 'Copied',
  'console.detail.session': 'Session',
  'console.detail.size': 'Size',
  'console.detail.time': 'Time',
  'console.detail.kind': 'Kind',
  'console.cleanup.expired': 'Clean expired files',
  'console.cleanup.session': 'Clear this session’s files',
  'console.cleanup.confirmTitle': 'Confirm cleanup',
  'console.cleanup.dryRun': '{count} file(s) would be deleted, freeing {size}.',
  'console.cleanup.execute': 'Delete now',
  'console.cleanup.cancel': 'Cancel',
  'console.cleanup.working': 'Working…',
  'console.cleanup.done': 'Deleted {count} file(s), freed {size}',
  'console.cleanup.failed': 'Cleanup failed: {message}',

  // ---- Settings ---------------------------------------------------------------
  'settings.tab': 'FileHub',
  'settings.section.general': 'General',
  'settings.section.privacy': 'Privacy',
  'settings.enabled': 'Enable FileHub',
  'settings.enabled.desc': 'Turning this off hides the console and upload entries.',
  'settings.ignorePastedMentions': 'Skip @ candidates for pasted text',
  'settings.ignorePastedMentions.desc': 'Paths pasted into the draft no longer offer mention candidates.',
  'settings.candidatesMax': 'Candidate limit',
  'settings.candidatesMax.desc': 'Maximum entries shown by the @ mention picker (1–200).',
  'settings.defaultView': 'Console default view',
  'settings.defaultView.desc': 'Grouping applied when the Files tab opens.',
  'settings.defaultView.grouped': 'By session',
  'settings.defaultView.flat': 'Flat list',
  'settings.localFirstVision': 'Local-first image display',
  'settings.localFirstVision.desc': 'Show local thumbnails first; outbound requests carry a banner marker.',
  'settings.visionMode': 'Vision mode',
  'settings.visionMode.desc': 'Controls how the vision waterfall sends images outward.',
  'settings.visionMode.off': 'Off',
  'settings.visionMode.caption': 'Caption only',
  'settings.visionMode.analyze': 'Full analysis',
  'settings.restoreDefaults': 'Restore defaults',
  'settings.restoreConfirm': 'Reset all values to defaults?',
  'settings.saved': 'Saved',
  'settings.saveError': 'Save failed: {message}',
  'settings.loading': 'Loading…',
}

export const FILEHUB_DICTS: Readonly<Record<Lang, Readonly<Record<string, string>>>> = { zh: ZH, en: EN }

/** Every dictionary key; zh/en key-set equality is enforced by unit tests. */
export type I18nKey = keyof typeof ZH

// ---------------------------------------------------------------------------
// Language state + translate
// ---------------------------------------------------------------------------

let currentLang: Lang = detectLang()
const listeners = new Set<() => void>()

/** Current UI language (host-bound when available, navigator otherwise). */
export function getI18nLang(): Lang {
  return currentLang
}

/** Switch the UI language and notify subscribers. No-op when unchanged. */
export function setI18nLang(lang: Lang): void {
  if (lang === currentLang) return
  currentLang = lang
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One broken subscriber must not starve the rest.
    }
  }
}

/** Subscribe to language changes; returns the unsubscribe function. */
export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Translate `key` in the current language with `{name}` interpolation.
 * Missing keys fall through en then the raw key — fail visible, never blank.
 */
export function t(key: I18nKey, params?: Record<string, string | number>): string {
  const template = FILEHUB_DICTS[currentLang][key] ?? FILEHUB_DICTS.en[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/** Structural subset of the host LocaleRuntime this module consumes. */
export interface HostLocaleFace {
  getLocale(): { readonly active: string }
  subscribe(listener: () => void): () => void
}

function activeToLang(active: string): Lang {
  return active === 'zh' ? 'zh' : 'en'
}

/**
 * Adopt the host's active locale and follow future switches. Safe on bare
 * contexts: an absent/malformed face leaves the navigator-derived language.
 */
export function bindHostLocale(face: HostLocaleFace | undefined): void {
  if (!face || typeof face.getLocale !== 'function' || typeof face.subscribe !== 'function') return
  try {
    setI18nLang(activeToLang(face.getLocale().active))
    face.subscribe(() =>{  setI18nLang(activeToLang(face.getLocale().active)) })
  } catch {
    // Host face threw mid-bind: keep the navigator fallback silently.
  }
}
