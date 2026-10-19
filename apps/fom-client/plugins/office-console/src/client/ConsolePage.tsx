import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Pill,
  SegmentedControl,
  Tag,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, LineTabs } from '@fominfo/dsh-ui'
import { type CatalogEntry, categoriesOf, type ConsoleView, filterEntries, groupByKind } from './catalog-view.ts'
import { CreateExpertDialog, CreateSkillDialog, ImportDialog, type ExpertDraft, type SkillDraft, type SubmitResult } from './dialogs.tsx'
import type { ImportKind } from './import-check.ts'
import { quotaView, type QuotaView } from './quota-view.ts'
import css from './ConsolePage.module.css'

/** 能力类型（三个 tab）。 */
type Kind = 'skill' | 'expert' | 'connector'

/** 三个 tab（技能 / 专家 / 连接器）。 */
const TABS = [
  { kind: 'skill', label: '技能', hint: 'SKILL.md 能力包' },
  { kind: 'expert', label: '专家', hint: '角色化 Agent 预设' },
  { kind: 'connector', label: '连接器', hint: '飞书 / MCP 等外部接入' },
] as const

/** 主 tab（line 型，顶级导航）。 */
const TAB_ITEMS = [
  { value: 'skill', label: '技能', id: 'office-console-tab-skill', panelId: 'office-console-panel-skill' },
  { value: 'expert', label: '专家', id: 'office-console-tab-expert', panelId: 'office-console-panel-expert' },
  { value: 'connector', label: '连接器', id: 'office-console-tab-connector', panelId: 'office-console-panel-connector' },
] as const

/** 每类标签色调（走 `Tag` 的 tone，不写颜色字面量）。 */
const KIND_TONE: Record<Kind, TagTone> = { skill: 'info', expert: 'warning', connector: 'success' }

/** 市场 / 已安装 双态（ui-primitives `SegmentedControl`）。 */
const VIEW_OPTIONS = [
  { value: 'market', label: '市场' },
  { value: 'installed', label: '已安装' },
] as const

/** 目录条目（来自 `/office/catalog`）——形状见 `./catalog-view.ts`。 */

interface PageState {
  status: 'loading' | 'ready' | 'error'
  entries?: CatalogEntry[]
  operatorRole?: string
  enabled?: Record<string, boolean>
  decisions?: Record<string, { allowed?: boolean }>
  /** 本周期配额（K4 本地配额执行 · 展示；拿不到就是「未同步」）。 */
  quota?: QuotaView
  error?: string
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return (await res.json()) as Record<string, unknown>
}

async function postJson(url: string): Promise<{ status: number; payload: unknown }> {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin' })
  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, payload }
}

async function postAction(body: unknown): Promise<{ status: number; payload: unknown }> {
  const res = await fetch('/api/office/console/action', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, payload }
}

function EntryCard({ entry, enabled, canAct, canExport, onToggle, onConnector, onSkillRemove, onExport }: { entry: CatalogEntry; enabled: boolean; canAct: boolean; canExport: boolean; onToggle: (id: string, on: boolean) => void; onConnector: (id: string, ref: string, install: boolean) => void; onSkillRemove: (slug: string) => void; onExport: (entry: CatalogEntry) => void }) {
  const installed = enabled
  const connectorRef = entry.kind === 'connector' ? entry.source?.ref : undefined
  const isConnector = connectorRef !== undefined && connectorRef !== ''
  const isLocalSkill = entry.kind === 'skill' && entry.origin === 'local'
  const tab = TABS.find((t) => t.kind === entry.kind)
  const tone = KIND_TONE[entry.kind as Kind] ?? 'neutral'
  return (
    <Card>
      <div className={css.cardHead}>
        <span aria-hidden="true" className={css.bubble}>
          {entry.icon ?? (tab ? tab.label[0] : '·')}
        </span>
        <span className={css.name}>{entry.name}</span>
        <Tag tone={entry.origin === 'local' ? 'neutral' : 'quiet'}>{entry.origin === 'local' ? '本地' : '平台'}</Tag>
        {entry.category ? <Tag tone={tone}>{entry.category}</Tag> : null}
      </div>
      <div className={css.desc}>{entry.description || '（无描述）'}</div>
      <div className={css.foot}>
        <span>v{entry.version || '—'}</span>
        <span>·</span>
        <span className={css.ref}>{entry.source ? entry.source.ref || entry.source.kind : '内置'}</span>
        {installed ? <Tag tone="success">已安装</Tag> : null}
        {canExport ? (
          <Button variant="ghost" size="sm" onClick={() => onExport(entry)}>导出</Button>
        ) : null}
        {canAct ? (
          <Button
            size="sm"
            variant={installed ? 'outline' : 'primary'}
            onClick={() => isConnector ? onConnector(entry.id, connectorRef ?? '', !installed) : isLocalSkill ? onSkillRemove(entry.id.replace(/^skill:/, '')) : onToggle(entry.id, !enabled)}
          >
            {isConnector ? (installed ? '卸载' : '+ 安装') : isLocalSkill ? '删除' : (installed ? '管理' : '+ 安装')}
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

/** office-console 主面板（三个 tab；顶级 line tabs + 子级 segment + 筛选 pill；新建/导入走对话框）。 */
export function ConsolePage() {
  const [state, setState] = useState<PageState>({ status: 'loading' })
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [tab, setTab] = useState<Kind>('skill')
  const [view, setView] = useState<ConsoleView>('market')
  const [category, setCategory] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [expertCreating, setExpertCreating] = useState(false)
  const [importing, setImporting] = useState<ImportKind | null>(null)

  const load = useCallback(async () => {
    const [catalog, st, quotaPayload] = await Promise.all([
      getJson('/office/catalog'),
      getJson('/office/console/state'),
      getJson('/api/office/quota').catch(() => null),
    ])
    const role = String(st.operatorRole ?? '')
    const actions = await getJson('/office/console/actions?role=' + encodeURIComponent(role))
    const capabilities = (st.capabilities as { id: string; enabled: boolean }[] | undefined) ?? []
    const decisions = (actions.decisions as { action: string; allowed?: boolean }[] | undefined) ?? []
    setState({
      status: 'ready',
      entries: (catalog.entries as CatalogEntry[] | undefined) ?? [],
      operatorRole: role,
      enabled: Object.fromEntries(capabilities.map((c) => [c.id, c.enabled])),
      decisions: Object.fromEntries(decisions.map((d) => [d.action, d])),
      quota: quotaView(quotaPayload),
    })
  }, [])

  useEffect(() => {
    let alive = true
    load().catch((e: unknown) => {
      if (alive) setState({ status: 'error', error: String((e as Error)?.message ?? e) })
    })
    return () => {
      alive = false
    }
  }, [load])

  const onToggle = useCallback(
    async (id: string, on: boolean) => {
      setNotice(null)
      const { status, payload } = await postAction({ action: 'capability.toggle', payload: { id, on } })
      if (status === 200) {
        await load()
        setNotice({ ok: true, text: `${id} → ${on ? '安装/启用' : '停用'}` })
      } else if (status === 202) setNotice({ ok: false, text: '需要审批（服务端未批准）' })
      else setNotice({ ok: false, text: `失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ''}` })
    },
    [load],
  )

  const onConnector = useCallback(
    async (id: string, ref: string, install: boolean) => {
      setNotice(null)
      const { status, payload } = await postAction({ action: install ? 'connector.install' : 'connector.remove', payload: { id, ref } })
      if (status === 200) {
        await load()
        setNotice({ ok: true, text: `${id} → ${install ? '已安装' : '已卸载'}` })
      } else if (status === 202) setNotice({ ok: false, text: '需要审批（服务端未批准）' })
      else setNotice({ ok: false, text: `失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ''}` })
    },
    [load],
  )

  /** 本地配额执行（K4）：拉一次平台配额并重载展示（**不阻断**——权威在网关）。 */
  const onSyncQuota = useCallback(async () => {
    setNotice(null)
    const { status, payload } = await postJson('/api/office/quota/sync')
    const ok = status === 200 && (payload as { ok?: boolean } | null)?.ok === true
    await load()
    setNotice(ok ? { ok: true, text: '配额已同步' } : { ok: false, text: `配额同步失败：HTTP ${status}` })
  }, [load])

  const onCreateSkill = useCallback(async (draft: SkillDraft): Promise<SubmitResult> => {
    setNotice(null)
    setBusy(true)
    try {
      const { status, payload } = await postAction({ action: 'skill.create', payload: draft })
      if (status === 200) {
        setCreating(false)
        await load()
        setNotice({ ok: true, text: `技能 ${draft.slug} 已创建` })
        return { ok: true, message: '已创建' }
      }
      // 失败（含 400 输入类）留在**对话框里**，不落页面通知。
      return { ok: false, message: status === 202 ? '需要审批（服务端未批准）' : `失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ''}` }
    } finally {
      setBusy(false)
    }
  }, [load])

  const onSkillRemove = useCallback(async (slug: string) => {
    setNotice(null)
    const { status, payload } = await postAction({ action: 'skill.remove', payload: { slug } })
    if (status === 200) {
      await load()
      setNotice({ ok: true, text: `技能 ${slug} 已删除` })
    } else if (status === 202) setNotice({ ok: false, text: '需要审批（服务端未批准）' })
    else setNotice({ ok: false, text: `失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ''}` })
  }, [load])

  const onCreateExpert = useCallback(async (draft: ExpertDraft): Promise<SubmitResult> => {
    setNotice(null)
    setBusy(true)
    try {
      const enable = [draft.planMode ? 'plan-mode' : null, draft.subagent ? 'tool-subagent' : null]
        .filter((id): id is string => id !== null)
      const { status, payload } = await postAction({
        action: 'expert.create',
        payload: {
          id: draft.id,
          name: draft.name,
          description: draft.description,
          persona: draft.personaPrefix === '' ? {} : { prefix: draft.personaPrefix },
          tools: { enable },
        },
      })
      if (status === 200) {
        setExpertCreating(false)
        await load()
        setNotice({ ok: true, text: `专家 ${draft.id} 已创建` })
        return { ok: true, message: '已创建' }
      }
      return { ok: false, message: status === 202 ? '需要审批（服务端未批准）' : `失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ''}` }
    } finally {
      setBusy(false)
    }
  }, [load])

  const onExport = useCallback(async (entry: CatalogEntry) => {
    setNotice(null)
    const isSkill = entry.kind === 'skill'
    const key = entry.id.replace(/^skill:/u, '').replace(/^expert:/u, '')
    const { status, payload } = await postAction({ action: isSkill ? 'skill.export' : 'expert.export', payload: isSkill ? { slug: key } : { id: key } })
    if (status !== 200) {
      setNotice({ ok: false, text: `导出失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ''}` })
      return
    }
    const bundle = (payload as { value?: { bundle?: unknown } } | null)?.value?.bundle
    const name = `${isSkill ? 'skill' : 'expert'}-${key}.json`
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(bundle, undefined, 2)}\n`], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice({ ok: true, text: `已导出 ${name}` })
  }, [])

  /** 导入（宿主权威校验）：成功关对话框；失败把**宿主原话**留在对话框里。 */
  const onImport = useCallback(async (kind: ImportKind, bundle: unknown): Promise<SubmitResult> => {
    setNotice(null)
    setBusy(true)
    try {
      const { status, payload } = await postAction({ action: `${kind}.import`, payload: { bundle } })
      if (status === 200) {
        setImporting(null)
        await load()
        setNotice({ ok: true, text: `已导入（${kind === 'skill' ? '技能' : '专家'}）` })
        return { ok: true, message: '已导入' }
      }
      const message = status === 202
        ? '需要审批（服务端未批准）'
        : `导入失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ''}`
      setNotice({ ok: false, text: message })
      return { ok: false, message }
    } finally {
      setBusy(false)
    }
  }, [load])

  if (state.status === 'loading') return <div className={css.page}>加载中…</div>
  if (state.status === 'error') return <div className={css.page}>读取失败：{state.error}</div>

  const byKind = groupByKind(state.entries ?? [])
  const canToggle = !!state.decisions?.['capability.toggle']?.allowed
  const active = TABS.find((t) => t.kind === tab) ?? TABS[0]

  const kindList = byKind[active.kind] ?? []
  const categories = categoriesOf(kindList)
  const list = filterEntries(kindList, view, category, state.enabled ?? {})
  // 新建/导入＝创建（同权限）；连接器无创建入口。
  const creatable = active.kind !== 'connector' && !!state.decisions?.[active.kind === 'skill' ? 'skill.create' : 'expert.create']?.allowed

  return (
    <div className={css.page}>
      <div className={css.head}>
        <h2 className={css.title}>专家 · 技能 · 连接器</h2>
        <span className={css.muted}>{`平台能力 · 操作者：${state.operatorRole}${canToggle ? '（可启停）' : '（只读）'}`}</span>
      </div>

      {state.quota ? (
        <div className={css.quota}>
          <span className={css.quotaTitle}>{state.quota.available && state.quota.period !== '' ? `本周期配额（${state.quota.period}）` : '本周期配额'}</span>
          {state.quota.rows.map((row) => (
            <span key={row.key} className={row.exceeded ? css.quotaExceeded : css.quotaItem}>
              {row.label} {row.used.toLocaleString()} / {row.limit === undefined ? '未设限' : row.limit.toLocaleString()}
            </span>
          ))}
          <Tag tone={state.quota.verdict === 'exceeded' ? 'danger' : state.quota.verdict === 'within' ? 'success' : 'neutral'}>
            {state.quota.note}
          </Tag>
          <div className={css.quotaActions}>
            <Button size="sm" variant="ghost" onClick={onSyncQuota}>同步配额</Button>
          </div>
        </div>
      ) : null}

      <div className={css.tabs}>
        <LineTabs
          items={TAB_ITEMS}
          value={tab}
          label="能力类型"
          onChange={(v) => {
            setTab(v)
            setCategory(null)
            setNotice(null)
          }}
        />
      </div>

      <div className={css.toolbar}>
        <SegmentedControl id="office-console-view" value={view} options={VIEW_OPTIONS} label="市场 / 已安装" onChange={(v) => { setView(v); setNotice(null) }} />
        {categories.length > 0 ? (
          <div className={css.categories}>
            <Pill active={category === null} onClick={() => setCategory(null)}>全部</Pill>
            {categories.map((c) => (
              <Pill key={c} active={category === c} onClick={() => setCategory(c)}>{c}</Pill>
            ))}
          </div>
        ) : null}
        {creatable ? (
          <div className={css.toolbarActions}>
            <Button variant="primary" size="sm" onClick={() => { if (active.kind === 'skill') setCreating(true); else setExpertCreating(true) }}>
              {active.kind === 'skill' ? '＋ 新建技能' : '＋ 新建专家'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setImporting(active.kind)}>
              {active.kind === 'skill' ? '导入技能' : '导入专家'}
            </Button>
          </div>
        ) : null}
      </div>

      {notice ? (
        <p className={`${css.notice} ${notice.ok ? css.noticeOk : css.noticeErr}`}>{notice.text}</p>
      ) : null}

      {list.length === 0 ? (
        <div className={css.empty}>{view === 'installed' ? `暂无已安装的${active.label}` : `暂无${active.label}`}</div>
      ) : (
        <div className={css.grid}>
          {list.map((entry) => {
            const connector = entry.kind === 'connector' && !!entry.source?.ref
            const canAct = !!state.decisions?.[connector ? 'connector.install' : 'capability.toggle']?.allowed
            const exportKey = entry.kind === 'skill' ? 'skill.export' : 'expert.export'
            const canExport = entry.origin === 'local' && !!state.decisions?.[exportKey]?.allowed
            return <EntryCard key={entry.id} entry={entry} enabled={!!state.enabled?.[entry.id]} canAct={canAct} canExport={canExport} onToggle={onToggle} onConnector={onConnector} onSkillRemove={onSkillRemove} onExport={onExport} />
          })}
        </div>
      )}

      <CreateSkillDialog open={creating} busy={busy} onClose={() => setCreating(false)} onSubmit={onCreateSkill} />
      <CreateExpertDialog open={expertCreating} busy={busy} onClose={() => setExpertCreating(false)} onSubmit={onCreateExpert} />
      <ImportDialog kind={importing ?? 'skill'} open={importing !== null} busy={busy} onClose={() => setImporting(null)} onImport={(bundle) => onImport(importing ?? 'skill', bundle)} />
    </div>
  )
}
