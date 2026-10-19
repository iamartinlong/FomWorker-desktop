import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card } from '@fominfo/dsh-ui'
import { type AssistantItem } from '../items.ts'
import { type AssistantDigest } from '../digest.ts'
import { doneLabel, groupItems, itemMeta } from './items-view.ts'
import css from './AssistantPage.module.css'

/** 契约 `TaskEntry`（D-5：task = 会话）。 */
interface TaskEntry {
  readonly taskId: string
  readonly title?: string
  readonly status: 'running' | 'idle' | 'failed'
  readonly updatedAt?: string
}

interface TasksPayload {
  ok: boolean
  tasks?: TaskEntry[]
  taskId?: string
  message?: string
}

interface ItemsPayload {
  ok: boolean
  items?: AssistantItem[]
  item?: AssistantItem
  digest?: AssistantDigest | null
  message?: string
}

async function call<T extends { ok: boolean; message?: string }>(url: string, init?: RequestInit): Promise<T> {
  try {
    const res = await fetch(url, init)
    return (await res.json()) as T
  } catch (error) {
    return { ok: false, message: String((error as Error)?.message ?? error) } as T
  }
}

const STATUS_LABEL: Record<TaskEntry['status'], string> = {
  running: '运行中',
  idle: '已结束',
  failed: '失败',
}

const STATUS_TONE: Record<TaskEntry['status'], 'info' | 'success' | 'warning'> = {
  running: 'info',
  idle: 'success',
  failed: 'warning',
}

function timeOf(value?: string): string {
  if (value === undefined) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * 「智能助理」面板：**我的任务 + 派活 + 我的待办**（执行端恒在 PC，D-5）。
 * 待办落本机域 `office_assistant_items`（跨会话/跨重启），与内核「自动化任务」页互不相干。
 */
export function AssistantPage() {
  const [tasks, setTasks] = useState<readonly TaskEntry[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const [items, setItems] = useState<readonly AssistantItem[]>([])
  const [digest, setDigest] = useState<AssistantDigest | null>(null)
  const [digestBusy, setDigestBusy] = useState(false)
  const [digestNote, setDigestNote] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [itemError, setItemError] = useState<string | null>(null)
  const [itemNote, setItemNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const payload = await call<TasksPayload>('/api/office/tasks')
    if (payload.ok) {
      setTasks(payload.tasks ?? [])
      setError(null)
    } else {
      setError(payload.message ?? '读取任务失败')
    }
  }, [])

  const refreshItems = useCallback(async () => {
    const payload = await call<ItemsPayload>('/api/office/items')
    if (payload.ok) {
      setItems(payload.items ?? [])
      setDigest(payload.digest ?? null)
      setItemError(null)
    } else {
      setItemError(payload.message ?? '读取待办失败')
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshItems()
  }, [refresh, refreshItems])

  const dispatch = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNote(null)
    const payload = await call<TasksPayload>('/api/office/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    setBusy(false)
    if (payload.ok) {
      setNote('已派到你的电脑')
      setText('')
      await refresh()
    } else {
      setError(payload.message ?? '派活失败')
    }
  }, [text, refresh])

  const addItem = useCallback(async () => {
    const payload = await call<ItemsPayload>('/api/office/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: draft }),
    })
    if (payload.ok) {
      setDraft('')
      await refreshItems()
    } else {
      setItemError(payload.message ?? '添加失败')
    }
  }, [draft, refreshItems])

  const toggleItem = useCallback(async (id: string) => {
    const payload = await call<ItemsPayload>(`/api/office/items?action=toggle&id=${encodeURIComponent(id)}`, {
      method: 'PUT',
    })
    if (payload.ok) await refreshItems()
    else setItemError(payload.message ?? '勾选失败')
  }, [refreshItems])

  const removeItem = useCallback(async (id: string) => {
    const payload = await call<ItemsPayload>(`/api/office/items?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (payload.ok) await refreshItems()
    else setItemError(payload.message ?? '删除失败')
  }, [refreshItems])

  const copyFromSession = useCallback(async () => {
    setItemError(null)
    setItemNote(null)
    const payload = await call<ItemsPayload & { created?: number }>('/api/office/items?action=copy-session', { method: 'POST' })
    if (!payload.ok) {
      setItemError(payload.message ?? '抄入失败')
      return
    }

    setItemNote(payload.created === 0 ? '会话里没有新的未完成项' : `已抄入 ${payload.created ?? 0} 条`)
    await refreshItems()
  }, [refreshItems])

  const generateDigest = useCallback(async () => {
    setDigestBusy(true)
    setDigestNote(null)
    setItemError(null)
    const payload = await call<ItemsPayload>('/api/office/items?action=digest', { method: 'POST' })
    setDigestBusy(false)
    if (!payload.ok) {
      setItemError(payload.message ?? '收拢失败')
      return
    }

    if (payload.digest === null || payload.digest === undefined) {
      setDigestNote(payload.message ?? '今天没有可收拢的事')
      return
    }

    setDigest(payload.digest)
    setDigestNote('已出今天的简报')
  }, [])

  const { open, done } = groupItems(items)
  const now = Date.now()
  return (
    <div className={css.page}>
      <h2 className={css.title}>智能助理</h2>
      <p className={css.lead}>看任务、派活、记待办；执行端始终在你自己的电脑上。</p>
      <Card>
        <div className={css.section}>
          我的任务
          <span className={css.sectionHint}>派到你电脑上跑的任务与结果</span>
        </div>
        {tasks.length === 0 ? (
          <span className={css.muted}>还没有任务。在下面说一句，就派到你的电脑上跑。</span>
        ) : (
          <ul className={css.list}>
            {tasks.map((task) => (
              <li key={task.taskId} className={css.row}>
                <span className={css.rowMain}>
                  <Tag tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Tag>
                  <span className={css.taskTitle}>{task.title ?? '（未命名）'}</span>
                </span>
                <span className={css.muted}>{timeOf(task.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card variant="form">
        <div className={css.section}>
          派活
          <span className={css.sectionHint}>在你的电脑上执行，本机文件与桌面应用都能用</span>
        </div>
        <label className={css.field}>
          说什么
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="例如：把今天的待办汇总成三条"
          />
        </label>
        <div>
          <Button variant="primary" size="sm" disabled={busy || text.trim() === ''} onClick={() => void dispatch()}>
            {busy ? '派活中…' : '派活'}
          </Button>
        </div>
        {note !== null ? <span className={css.muted}>{note}</span> : null}
        {error !== null ? <span className={css.error}>{error}</span> : null}
      </Card>

      <Card>
        <div className={css.section}>
          我的待办
          <span className={css.sectionHint}>只存在这台电脑上，跨会话、重启都在</span>
        </div>
        {open.length === 0 ? (
          <span className={css.muted}>
            {done.length === 0 ? '还没有待办。想到什么就写一条，它只在本机、跨会话都在。' : '没有未完成的。'}
          </span>
        ) : (
          <ul className={css.list}>
            {open.map((item) => (
              <li key={item.id} className={css.row}>
                <span className={css.rowMain}>
                  <input type="checkbox" checked={false} onChange={() => void toggleItem(item.id)} aria-label="完成" />
                  <span className={css.taskTitle}>{item.text}</span>
                </span>
                <span className={css.rowMain}>
                  <span className={css.muted}>{itemMeta(item, now)}</span>
                  <Button variant="outline" size="sm" onClick={() => void removeItem(item.id)}>
                    删除
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {done.length > 0 ? (
          <div>
            <Button variant="outline" size="sm" onClick={() => setShowDone(!showDone)}>
              {doneLabel(done.length)}
            </Button>
            {showDone ? (
              <ul className={css.list}>
                {done.map((item) => (
                  <li key={item.id} className={css.row}>
                    <span className={css.rowMain}>
                      <input type="checkbox" checked onChange={() => void toggleItem(item.id)} aria-label="取消完成" />
                      <span className={css.taskTitle}>{item.text}</span>
                    </span>
                    <span className={css.muted}>{itemMeta(item, now)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <label className={css.field}>
          加一条
          <Input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="例如：周三前交周报" />
        </label>
        <div className={css.actions}>
          <Button variant="primary" size="sm" disabled={draft.trim() === ''} onClick={() => void addItem()}>
            添加
          </Button>
          <Button variant="outline" size="sm" onClick={() => void copyFromSession()}>
            从会话抄进来
          </Button>
        </div>
        {itemNote !== null ? <span className={css.muted}>{itemNote}</span> : null}
        {itemError !== null ? <span className={css.error}>{itemError}</span> : null}
      </Card>

      <Card>
        <div className={css.section}>
          日终简报
          <span className={css.sectionHint}>把今天做完的和还欠着的收成一条，只在本机</span>
        </div>
        {digest === null ? (
          <span className={css.muted}>
            还没有简报。到点会自动出一份，也可以现在出。
          </span>
        ) : (
          <div>
            <div className={css.digestHead}>
              <Tag tone="info">{digest.date}</Tag>
              <span className={css.muted}>
                {digest.doneToday > 0 ? `完成 ${digest.doneToday}` : '今天还没完成'}
                {digest.openCount > 0 ? ` · 待办 ${digest.openCount}` : ' · 已清空'}
                {digest.overdueCount > 0 ? ` · 逾期 ${digest.overdueCount}` : ''}
              </span>
            </div>
            <ul className={css.list}>
              {digest.lines.map((line, index) => (
                <li key={`${String(index)}-${line}`} className={css.digestLine}>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={digestBusy} onClick={() => void generateDigest()}>
            {digestBusy ? '收拢中…' : '现在收拢'}
          </Button>
        </div>
        {digestNote !== null ? <span className={css.muted}>{digestNote}</span> : null}
      </Card>

      <span className={css.muted}>
        提醒 / 日程在侧栏「自动化任务」里管理（内核页）。
      </span>
    </div>
  )
}
