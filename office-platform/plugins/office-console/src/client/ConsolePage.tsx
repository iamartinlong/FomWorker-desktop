import { useCallback, useEffect, useState } from 'react'
import { type CatalogEntry, categoriesOf, type ConsoleView, filterEntries, groupByKind } from './catalog-view.ts'

/** 三个 tab（技能 / 专家 / 连接器）。 */
const TABS = [
  { kind: 'skill', label: '技能', hint: 'SKILL.md 能力包' },
  { kind: 'expert', label: '专家', hint: '角色化 Agent 预设' },
  { kind: 'connector', label: '连接器', hint: '飞书 / MCP 等外部接入' },
] as const

/** 每类强调色。 */
const ACCENT: Record<string, string> = { skill: '#038AC6', expert: '#7C5CFC', connector: '#FCB513' }

/** 市场 / 已安装 双态。 */
const VIEWS = [
  { id: 'market', label: '市场' },
  { id: 'installed', label: '已安装' },
] as const

/** 目录条目（来自 `/office/catalog`）——形状见 `./catalog-view.ts`。 */

interface PageState {
  status: 'loading' | 'ready' | 'error'
  entries?: CatalogEntry[]
  operatorRole?: string
  enabled?: Record<string, boolean>
  decisions?: Record<string, { allowed?: boolean }>
  error?: string
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return (await res.json()) as Record<string, unknown>
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

/** 分类/筛选用的胶囊。 */
function Chip({ text, color, active, onClick }: { text: string; color: string; active: boolean; onClick?: () => void }) {
  const style: React.CSSProperties = {
    fontSize: 11.5,
    lineHeight: '18px',
    padding: '1px 9px',
    borderRadius: 999,
    background: active ? color + '22' : 'transparent',
    color: active ? color : 'inherit',
    border: '1px solid ' + (active ? color + '66' : 'rgba(128,128,128,0.3)'),
    whiteSpace: 'nowrap',
    cursor: onClick ? 'pointer' : 'default',
    opacity: active ? 1 : 0.7,
  }
  return onClick ? (
    <button style={style} onClick={onClick}>
      {text}
    </button>
  ) : (
    <span style={style}>{text}</span>
  )
}

/** 分段控件（市场 / 已安装）。 */
function Seg({ items, activeId, onPick, accent }: { items: readonly { id: string; label: string }[]; activeId: string; onPick: (id: string) => void; accent: string }) {
  return (
    <div style={{ display: 'inline-flex', padding: 2, borderRadius: 9, background: 'rgba(128,128,128,0.12)', gap: 2 }}>
      {items.map((it) => {
        const on = it.id === activeId
        return (
          <button
            key={it.id}
            onClick={() => onPick(it.id)}
            style={{
              border: 'none',
              cursor: 'pointer',
              borderRadius: 7,
              padding: '4px 12px',
              fontSize: 12.5,
              background: on ? accent : 'transparent',
              color: on ? '#fff' : 'inherit',
              fontWeight: on ? 600 : 500,
            }}
          >
            {it.label}
          </button>
        )
      })}
    </div>
  )
}

function EntryCard({ entry, enabled, canToggle, onToggle }: { entry: CatalogEntry; enabled: boolean; canToggle: boolean; onToggle: (id: string, on: boolean) => void }) {
  const accent = ACCENT[entry.kind] ?? '#666'
  const installed = enabled
  const tab = TABS.find((t) => t.kind === entry.kind)
  return (
    <div style={{ border: '1px solid rgba(128,128,128,0.22)', borderRadius: 12, padding: 14, background: 'rgba(128,128,128,0.04)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: 10, background: accent + '22', color: accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, flex: '0 0 auto' }}>
          {entry.icon ?? (tab ? tab.label[0] : '·')}
        </span>
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0 }}>{entry.name}</span>
        {entry.category ? <Chip text={entry.category} color={accent} active /> : null}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, opacity: 0.75, minHeight: 38, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {entry.description || '（无描述）'}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, fontSize: 11.5, opacity: 0.75 }}>
        <span>v{entry.version || '—'}</span>
        <span>·</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.source ? entry.source.ref || entry.source.kind : '内置'}
        </span>
        {installed ? <span style={{ color: '#137333', fontWeight: 600 }}>● 已安装</span> : null}
        {canToggle ? (
          <button
            onClick={() => onToggle(entry.id, !enabled)}
            style={{ fontSize: 12, padding: '3px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, border: '1px solid ' + accent + '66', background: installed ? 'transparent' : accent, color: installed ? accent : '#fff' }}
          >
            {installed ? '管理' : '+ 安装'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** office-console 主面板（三个 tab · 静态只读，参考 WorkBuddy 范式）。 */
export function ConsolePage() {
  const [state, setState] = useState<PageState>({ status: 'loading' })
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [tab, setTab] = useState<string>('skill')
  const [view, setView] = useState<string>('market')
  const [category, setCategory] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [catalog, st] = await Promise.all([getJson('/office/catalog'), getJson('/office/console/state')])
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

  if (state.status === 'loading') return <div style={{ padding: 16 }}>加载中…</div>
  if (state.status === 'error') return <div style={{ padding: 16, color: 'crimson' }}>读取失败：{state.error}</div>

  const byKind = groupByKind(state.entries ?? [])
  const canToggle = !!state.decisions?.['capability.toggle']?.allowed
  const active = TABS.find((t) => t.kind === tab) ?? TABS[0]
  const accent = ACCENT[active.kind] ?? '#038AC6'

  const kindList = byKind[active.kind] ?? []
  const categories = categoriesOf(kindList)
  const list = filterEntries(kindList, view as ConsoleView, category, state.enabled ?? {})

  return (
    <div style={{ padding: '18px 20px', fontFamily: 'system-ui', lineHeight: 1.6, width: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>专家 · 技能 · 连接器</h2>
        <span style={{ fontSize: 12, opacity: 0.6 }}>{`平台能力 · 操作者：${state.operatorRole}${canToggle ? '（可启停）' : '（只读）'}`}</span>
      </div>

      {/* 三个 tab（技能 / 专家 / 连接器） */}
      <div style={{ display: 'flex', gap: 4, margin: '14px 0 14px', borderBottom: '1px solid rgba(128,128,128,0.2)' }}>
        {TABS.map((t) => {
          const on = t.kind === active.kind
          const n = (byKind[t.kind] ?? []).length
          return (
            <button
              key={t.kind}
              onClick={() => {
                setTab(t.kind)
                setCategory(null)
                setNotice(null)
              }}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '8px 14px', fontSize: 13.5, fontWeight: on ? 700 : 500, color: on ? ACCENT[t.kind] : 'inherit', opacity: on ? 1 : 0.65, borderBottom: '2px solid ' + (on ? ACCENT[t.kind] : 'transparent'), marginBottom: -1 }}
            >
              {t.label}
              <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 12 }}>{`(${n})`}</span>
            </button>
          )
        })}
      </div>

      {/* 市场 / 已安装 双态 + 分类筛选 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <Seg items={VIEWS} activeId={view} onPick={(v) => { setView(v); setNotice(null) }} accent={accent} />
        {categories.length > 0 ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Chip text="全部" color={accent} active={category === null} onClick={() => setCategory(null)} />
            {categories.map((c) => (
              <Chip key={c} text={c} color={accent} active={category === c} onClick={() => setCategory(c)} />
            ))}
          </div>
        ) : null}
        <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.55 }}>{`${active.label} · ${active.hint} · ${list.length} 项`}</span>
      </div>

      {notice ? <p style={{ margin: '0 0 12px', fontSize: 13, color: notice.ok ? '#137333' : 'crimson' }}>{notice.text}</p> : null}

      {list.length === 0 ? (
        <div style={{ opacity: 0.6, fontSize: 13, padding: '28px 0', textAlign: 'center' }}>{view === 'installed' ? `暂无已安装的${active.label}` : `暂无${active.label}`}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12 }}>
          {list.map((entry) => (
            <EntryCard key={entry.id} entry={entry} enabled={!!state.enabled?.[entry.id]} canToggle={canToggle} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  )
}
