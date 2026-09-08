/**
 * zdsh-plugin-center — web client surface.
 *
 * Loaded by the host module loader as a CJS block exposing {inject, apply}
 * (react arrives through the loader's require, exactly like any peer).
 * Registers a settings section (order 30, after inventory/governance) and
 * talks to the plugin's own /api2 routes on the same origin.
 */
import { useEffect, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import { pluginCenterStyles } from './styles.js'

export const PLUGIN_CENTER_SLOT_ID = 'zdsh-plugin-center'
export const PLUGIN_CENTER_SLOT_ORDER = 30
export const INTENT_HEADER = 'x-zdsh-pc-intent'
const API = '/api2/zdsh-plugin-center'

export const inject = ['slots']

interface SlotsLike {
  inject(name: string, mount: () => (() => void)): void
  register(
    options: { name: string; id: string; order: number; label: string },
    component: () => ReactNode,
  ): () => void
}

export interface ClientContext {
  effect(mount: () => (() => void), description?: string): void
  slots: SlotsLike
}

// ------------------------------------------------------------------ data types

export interface EntryView {
  id: string
  source: 'github' | 'npm'
  title: { zh: string; en: string }
  summary: { zh: string; en: string }
  category: string
  evidence: 'discovered' | 'installable' | 'verified' | 'recommended'
  compat: 'exact' | 'range-supported' | 'unknown'
  scriptsPolicy: 'none' | 'allowlisted'
}

export interface MarketPageView {
  items: EntryView[]
  page: number
  pageSize: number
  total: number
  mode: 'fresh' | 'cached' | 'seed'
}

interface RuntimeView {
  bootId: string
}

interface AuditRow {
  ts?: string
  action?: string
  step?: string
  outcome?: string
}

type Locale = 'zh' | 'en'

// ------------------------------------------------------------------ i18n

const messages = {
  zh: {
    brand: 'ZDSH 插件中心',
    sub: '发现 · 信任 · 安全安装 · 审计',
    search: '搜索名称、仓库或包名，回车确认…',
    allCategories: '分类过滤…',
    recommendedOnly: '只看推荐',
    install: '安装',
    evidenceRecommended: '推荐',
    evidenceVerified: '已验证',
    evidenceInstallable: '可安装',
    evidenceDiscovered: '仅发现',
    compatExact: '兼容',
    compatRange: '范围支持·待验证',
    compatUnknown: '兼容性未知',
    sourceGithub: 'GitHub 固定 commit',
    sourceNpm: 'npm 固定版本',
    offlineHint: '当前为离线快照目录，数据可能不是最新。',
    confirmTitle: '确认安装',
    confirmHint: '请输入下方确认码后执行（一次性计划，防误触）：',
    cancelButton: '取消',
    confirmButton: '执行',
    appliedTitle: '已应用，等待重启生效',
    appliedBody: '依赖变更将在宿主重启后生效。',
    failedTitle: '操作失败',
    auditHeading: '审计记录（最近）',
    loading: '加载中…',
    empty: '没有匹配的插件。',
    prevPage: '上一页',
    nextPage: '下一页',
    opsHeading: '运维',
    guardianLabel: '看门狗',
    start: '启动',
    stop: '停止',
    backupsLabel: '备份快照',
    restoreBtn: '恢复',
    confirmRestore: (name: string): string =>
      `恢复备份 ${name}？请输入确认码继续：`,
    uninstall: '卸载',
    pageInfo: (a: number, b: number, c: number): string =>
      `第 ${String(a)} / ${String(b)} 页 · 共 ${String(c)} 条`,
    sourceOf: (entry: EntryView): string =>
      entry.source === 'github' ? messages.zh.sourceGithub : messages.zh.sourceNpm,
  },
  en: {
    brand: 'ZDSH Plugin Center',
    sub: 'Discover · Trust · Safe installs · Audit',
    search: 'Search names, repos or packages, press Enter…',
    allCategories: 'Filter by category…',
    recommendedOnly: 'Recommended only',
    install: 'Install',
    evidenceRecommended: 'Recommended',
    evidenceVerified: 'Verified',
    evidenceInstallable: 'Installable',
    evidenceDiscovered: 'Discovered',
    compatExact: 'Compatible',
    compatRange: 'Range supported · unverified',
    compatUnknown: 'Compatibility unknown',
    sourceGithub: 'GitHub pinned commit',
    sourceNpm: 'npm pinned version',
    offlineHint: 'Showing an offline snapshot catalog; data may be stale.',
    confirmTitle: 'Confirm install',
    confirmHint: 'Type the confirmation code to apply this one-shot plan:',
    cancelButton: 'Cancel',
    confirmButton: 'Apply',
    appliedTitle: 'Applied — restart required',
    appliedBody: 'Dependency changes take effect after the host restarts.',
    failedTitle: 'Operation failed',
    auditHeading: 'Recent audit trail',
    loading: 'Loading…',
    empty: 'No matching plugins.',
    prevPage: 'Prev',
    nextPage: 'Next',
    opsHeading: 'Operations',
    guardianLabel: 'Watchdog',
    start: 'Start',
    stop: 'Stop',
    backupsLabel: 'Backup snapshots',
    restoreBtn: 'Restore',
    confirmRestore: (name: string): string =>
      `Restore backup ${name}? Type the confirmation code to continue:`,
    uninstall: 'Uninstall',
    pageInfo: (a: number, b: number, c: number): string =>
      `Page ${String(a)} / ${String(b)} · ${String(c)} entries`,
    sourceOf: (entry: EntryView): string =>
      entry.source === 'github' ? messages.en.sourceGithub : messages.en.sourceNpm,
  },
} as const

export function evidenceLabel(evidence: EntryView['evidence'], locale: Locale): string {
  const t = messages[locale]
  if (evidence === 'recommended') return t.evidenceRecommended
  if (evidence === 'verified') return t.evidenceVerified
  if (evidence === 'installable') return t.evidenceInstallable
  return t.evidenceDiscovered
}

export function compatLabel(compat: EntryView['compat'], locale: Locale): string {
  const key = compat === 'exact' ? 'compatExact' : compat === 'range-supported' ? 'compatRange' : 'compatUnknown'
  return (locale === 'zh' ? messages.zh : messages.en)[key]
}

// ------------------------------------------------------------------ api helpers

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`GET ${path} → ${String(response.status)}`)
  return (await response.json()) as T
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [INTENT_HEADER]: PLUGIN_CENTER_SLOT_ID },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(payload.error?.message ?? `POST ${path} failed`)
  return payload
}

export function marketUrl(params: {
  page: number
  q: string
  category: string
  onlyRecommended: boolean
}): string {
  const search = new URLSearchParams()
  search.set('page', String(Math.max(1, params.page)))
  search.set('pageSize', '24')
  if (params.q.trim() !== '') search.set('q', params.q.trim())
  if (params.category !== '') search.set('category', params.category)
  if (params.onlyRecommended) search.set('onlyRecommended', '1')
  return `${API}/market?${search.toString()}`
}

// ------------------------------------------------------------------ state model

interface DialogState {
  planId: string
  entryId: string
  action: 'install' | 'update' | 'uninstall'
  confirmCode: string
  phraseFull: string
}

interface GuardianView {
  running: boolean
  state: string
  port: number
}

interface BackupRow {
  name: string
  createdAtMs: number
}

export function extractSha8(phrase: string): string {
  const match = phrase.match(/@([0-9a-f]{12})\b/)
  return match?.[1] ?? ''
}

/** Headline component: catalog browsing plus the one-shot confirm flow. */
export function PluginCenterApp(props: { locale?: Locale }): ReactNode {
  const locale: Locale = props.locale ?? 'zh'
  const t = messages[locale]
  const [data, setData] = useState<MarketPageView | null>(null)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [category, setCategory] = useState('')
  const [onlyRec, setOnlyRec] = useState(false)
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState('')
  const [auditTail, setAuditTail] = useState<AuditRow[]>([])
  const [guardian, setGuardian] = useState<GuardianView | null>(null)
  const [backups, setBackups] = useState<BackupRow[]>([])

  useEffect(() => {
    let alive = true
    apiGet<MarketPageView>(marketUrl({ page, q: submitted, category, onlyRecommended: onlyRec }))
      .then((next) => {
        if (alive) setData(next)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [page, submitted, category, onlyRec])

  // Boot guard: when the host reloads under a new boot id, refresh once.
  useEffect(() => {
    let lastBoot = ''
    const timer = window.setInterval(() => {
      apiGet<RuntimeView>(`${API}/runtime`)
        .then((runtime) => {
          if (lastBoot === '') {
            lastBoot = runtime.bootId
            return
          }
          if (runtime.bootId !== lastBoot) {
            lastBoot = runtime.bootId
            apiGet<MarketPageView>(marketUrl({ page: 1, q: '', category: '', onlyRecommended: false }))
              .then(setData)
              .catch(() => undefined)
          }
        })
        .catch(() => undefined)
      apiGet<GuardianView>(`${API}/guardian/status`).then(setGuardian).catch(() => undefined)
    }, 5000)
    apiGet<GuardianView>(`${API}/guardian/status`).then(setGuardian).catch(() => undefined)
    apiGet<BackupRow[]>(`${API}/backups`).then(setBackups).catch(() => undefined)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  const refreshOps = (): void => {
    apiGet<GuardianView>(`${API}/guardian/status`).then(setGuardian).catch(() => undefined)
    apiGet<BackupRow[]>(`${API}/backups`).then(setBackups).catch(() => undefined)
    apiGet<AuditRow[]>(`${API}/audit`).then(setAuditTail).catch(() => undefined)
  }

  const stagePlanFor = async (
    entryId: string,
    action: 'install' | 'update' | 'uninstall',
  ): Promise<void> => {
    setError('')
    try {
      const result = await apiPost<{ planId: string; phrase: string }>(`${API}/plan/stage`, {
        action,
        entryId,
      })
      setDialog({
        planId: result.planId,
        entryId,
        action,
        phraseFull: result.phrase,
        confirmCode: extractSha8(result.phrase),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const applyStaged = async (): Promise<void> => {
    if (!dialog) return
    try {
      await apiPost(`${API}/plan/apply`, { planId: dialog.planId, phrase: dialog.phraseFull })
      setDialog(null)
      setApplied(true)
      refreshOps()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDialog(null)
    }
  }

  const toggleGuardian = async (action: 'start' | 'stop'): Promise<void> => {
    setError('')
    try {
      await apiPost(`${API}/guardian/toggle`, { action })
      refreshOps()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const restoreOne = async (name: string): Promise<void> => {
    setError('')
    try {
      // Two-phase: stage returns a one-shot code the user confirms.
      const staged = await apiPost<{ restoreId: string; code: string }>(
        `${API}/backups/restore`,
        { name },
      )
      const typed = window.prompt(t.confirmRestore(name), staged.code)
      if (typed === null || typed.trim() !== staged.code) return
      await apiPost(`${API}/backups/restore/apply`, {
        restoreId: staged.restoreId,
        code: staged.code,
      })
      refreshOps()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / (data?.pageSize ?? 24)))

  return (
    <div className="zdsh-pc">
      <style>{pluginCenterStyles}</style>
      <div>
        <div style={{ fontSize: '13px', fontWeight: 600 }}>{t.brand}</div>
        <div className="zdsh-pc-note">{t.sub}</div>
      </div>
      {applied ? (
        <div className="zdsh-pc-banner" role="status">
          <strong>{t.appliedTitle}</strong> — {t.appliedBody}
        </div>
      ) : null}
      {error !== '' ? <div className="zdsh-pc-banner" role="alert">{`${t.failedTitle}: ${error}`}</div> : null}
      {data !== null && data.mode !== 'fresh' ? <div className="zdsh-pc-note">{t.offlineHint}</div> : null}
      <div className="zdsh-pc-toolbar">
        <input
          className="zdsh-pc-input"
          type="search"
          placeholder={t.search}
          value={query}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setQuery(e.target.value)
            if (e.target.value === '') setSubmitted('')
          }}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
              setPage(1)
              setSubmitted(query)
            }
          }}
        />
        <input
          className="zdsh-pc-input"
          type="search"
          style={{ maxWidth: '130px' }}
          placeholder={t.allCategories}
          value={category}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setPage(1)
            setCategory(e.target.value)
          }}
        />
        <label className="zdsh-pc-toggle">
          <input
            type="checkbox"
            checked={onlyRec}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setPage(1)
              setOnlyRec(e.target.checked)
            }}
          />
          {t.recommendedOnly}
        </label>
      </div>
      <EntryList
        data={data}
        locale={locale}
        onInstall={(id) => {
          void stagePlanFor(id, 'install')
        }}
        onUninstall={(id) => {
          void stagePlanFor(id, 'uninstall')
        }}
      />
      <div className="zdsh-pc-pager">
        <button
          className="zdsh-pc-btn"
          disabled={page <= 1}
          onClick={() => {
            setPage(page - 1)
          }}
        >
          {t.prevPage}
        </button>
        <span className="zdsh-pc-note">{t.pageInfo(page, pageCount, total)}</span>
        <button
          className="zdsh-pc-btn"
          disabled={page >= pageCount}
          onClick={() => {
            setPage(page + 1)
          }}
        >
          {t.nextPage}
        </button>
      </div>
      <div>
        <div className="zdsh-pc-note">{`${t.opsHeading} · ${t.guardianLabel}${guardian ? ` [${guardian.state}]` : ''}`}</div>
        <div className="zdsh-pc-toolbar">
          <button
            className="zdsh-pc-btn"
            onClick={() => {
              void toggleGuardian('start')
            }}
          >
            {t.start}
          </button>
          <button
            className="zdsh-pc-btn"
            onClick={() => {
              void toggleGuardian('stop')
            }}
          >
            {t.stop}
          </button>
        </div>
      </div>
      <div>
        <div className="zdsh-pc-note">{`${t.opsHeading} · ${t.backupsLabel}`}</div>
        {backups.length === 0 ? (
          <div className="zdsh-pc-note">—</div>
        ) : (
          backups.slice(0, 5).map(row => (
            <div className="zdsh-pc-audit-row" key={row.name}>
              <span>{new Date(row.createdAtMs).toISOString()}</span>
              <span>{row.name}</span>
              <button
                className="zdsh-pc-btn"
                onClick={() => {
                  void restoreOne(row.name)
                }}
              >
                {t.restoreBtn}
              </button>
            </div>
          ))
        )}
      </div>
      {auditTail.length > 0 ? (
        <div>
          <div className="zdsh-pc-note">{t.auditHeading}</div>
          {auditTail.slice(-8).map((row, index) => (
            <div className="zdsh-pc-audit-row" key={`${row.ts ?? ''}-${String(index)}`}>
              <span>{row.ts ?? ''}</span>
              <span>{`${row.action ?? ''}:${row.step ?? ''}`}</span>
              <span>{row.outcome ?? ''}</span>
            </div>
          ))}
        </div>
      ) : null}
      {dialog !== null ? (
        <ConfirmDialog
          dialog={dialog}
          locale={locale}
          onCancel={() => {
            setDialog(null)
          }}
          onConfirm={() => {
            void applyStaged()
          }}
        />
      ) : null}
    </div>
  )
}

function EntryList(props: {
  data: MarketPageView | null
  locale: Locale
  onInstall: (entryId: string) => void
  onUninstall: (entryId: string) => void
}): ReactNode {
  const t = messages[props.locale]
  if (props.data === null) return <div className="zdsh-pc-note">{t.loading}</div>
  if (props.data.items.length === 0) return <div className="zdsh-pc-note">{t.empty}</div>
  return (
    <div className="zdsh-pc-list">
      {props.data.items.map(item => (
        <EntryCard
          key={item.id}
          entry={item}
          locale={props.locale}
          onInstall={() => {
            props.onInstall(item.id)
          }}
          onUninstall={() => {
            props.onUninstall(item.id)
          }}
        />
      ))}
    </div>
  )
}

function EntryCard(props: {
  entry: EntryView
  locale: Locale
  onInstall: () => void
  onUninstall: () => void
}): ReactNode {
  const t = messages[props.locale]
  const item = props.entry
  const evidenceClass =
    item.evidence === 'recommended' || item.evidence === 'verified'
      ? 'zdsh-pc-badge zdsh-pc-badge-good'
      : 'zdsh-pc-badge'
  const compatClass =
    item.compat === 'exact'
      ? 'zdsh-pc-badge zdsh-pc-badge-good'
      : item.compat === 'range-supported'
        ? 'zdsh-pc-badge zdsh-pc-badge-warn'
        : 'zdsh-pc-badge zdsh-pc-badge-dim'
  return (
    <div className="zdsh-pc-card">
      <div className="zdsh-pc-card-main">
        <div className="zdsh-pc-card-title">{item.title[props.locale]}</div>
        <div className="zdsh-pc-card-desc">{item.summary[props.locale]}</div>
        <div className="zdsh-pc-badges">
          <span className={evidenceClass}>{evidenceLabel(item.evidence, props.locale)}</span>
          <span className={compatClass}>{compatLabel(item.compat, props.locale)}</span>
          <span className="zdsh-pc-badge zdsh-pc-badge-dim">{t.sourceOf(item)}</span>
        </div>
      </div>
      <div className="zdsh-pc-toolbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '6px' }}>
        <button className="zdsh-pc-btn" disabled={item.evidence === 'discovered'} onClick={props.onInstall}>
          {t.install}
        </button>
        <button className="zdsh-pc-btn" disabled={item.evidence === 'discovered'} onClick={props.onUninstall}>
          {t.uninstall}
        </button>
      </div>
    </div>
  )
}

function ConfirmDialog(props: {
  dialog: DialogState
  locale: Locale
  onCancel: () => void
  onConfirm: () => void
}): ReactNode {
  const t = messages[props.locale]
  const [typed, setTyped] = useState('')
  const ready = typed === props.dialog.confirmCode
  return (
    <div className="zdsh-pc-dialog-backdrop" role="presentation">
      <div className="zdsh-pc-dialog" role="dialog" aria-modal="true">
        <strong>{t.confirmTitle}</strong>
        <div className="zdsh-pc-note">{`${props.dialog.action} · ${props.dialog.entryId}`}</div>
        <div className="zdsh-pc-code">{props.dialog.confirmCode}</div>
        <label className="zdsh-pc-note">{t.confirmHint}</label>
        <input
          className="zdsh-pc-input"
          value={typed}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setTyped(e.target.value)
          }}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && ready) props.onConfirm()
          }}
        />
        <div className="zdsh-pc-actions">
          <button className="zdsh-pc-btn" onClick={props.onCancel}>
            {t.cancelButton}
          </button>
          <button className="zdsh-pc-btn" disabled={!ready} onClick={props.onConfirm}>
            {t.confirmButton}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Register the plugin center as its own settings section (order 30). */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: PLUGIN_CENTER_SLOT_ID,
            order: PLUGIN_CENTER_SLOT_ORDER,
            label: messages.zh.brand,
          },
          () => <PluginCenterApp locale="zh" />,
        ),
      )
      return () => undefined
    },
    'zdsh-plugin-center: settings section',
  )
}
