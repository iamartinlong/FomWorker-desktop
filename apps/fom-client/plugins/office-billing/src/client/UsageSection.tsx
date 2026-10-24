/**
 * 设置页「用量与配额」。
 *
 * 三个维度（Token / 金额 / 调用次数）各一行：已用 / 限额 + 进度条；顶部是周期与一句裁决。
 * 数据经宿主代理（令牌不过浏览器）；「同步配额」从平台拉一次。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { quotaView, type QuotaRow, type QuotaView } from './quota-view.ts'
import css from './UsageSection.module.css'

/** 宿主配额读路由。 */
export const QUOTA_ROUTE = '/api/office/quota'

/** 宿主配额同步路由。 */
export const QUOTA_SYNC_ROUTE = '/api/office/quota/sync'

/**
 * 宿主模式标记路由（`office-login` 的；这里只读不写）。
 *
 * 为什么设置页要读它：未登录时配额必然为空，但「空」和「没数据」是两种不同的处境——
 * 前者应当直接说「你还没登录」，而不是让用户点「同步配额」才发现拉不到。
 */
export const MODE_ROUTE = '/api/office/login/mode'

/** 读宿主侧当前模式（读不到 ⇒ `undefined`，空态退回中性文案）。 */
async function readSignedIn(): Promise<boolean | undefined> {
  try {
    const res = await fetch(MODE_ROUTE)
    const payload = (await res.json()) as { ok?: boolean; mode?: unknown }
    if (payload.ok !== true || typeof payload.mode !== 'string') return undefined
    return payload.mode === 'signed'
  } catch {
    return undefined
  }
}

interface QuotaPayload {
  ok: boolean
  message?: string
}

async function getQuota(): Promise<unknown> {
  try {
    const res = await fetch(QUOTA_ROUTE)
    return await res.json()
  } catch (error) {
    return { ok: false, message: String((error as Error)?.message ?? error) }
  }
}

/** 一行的进度（`undefined` ＝ 未设限 ⇒ 不画进度条）。 */
function ratioOf(row: QuotaRow): number | undefined {
  if (row.limit === undefined || row.limit <= 0) return undefined
  return Math.min(1, row.used / row.limit)
}

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN')
}

/**
 * 用量与配额设置页。
 * @returns 设置页内容
 */
export function UsageSection() {
  const [view, setView] = useState<QuotaView | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // 模式与配额一起取：未登录时文案要能说清「是没登录，不是没数据」。
    const [payload, signedIn] = await Promise.all([getQuota(), readSignedIn()])
    setView(quotaView(payload, signedIn))
    const message = (payload as QuotaPayload | undefined)?.message
    if (typeof message === 'string' && message !== '') setError(message)
    else setError(null)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sync = useCallback(async () => {
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const res = await fetch(QUOTA_SYNC_ROUTE, { method: 'POST' })
      const payload = (await res.json()) as QuotaPayload
      if (payload.ok) {
        setNote('已同步')
        await load()
      } else {
        setError(payload.message ?? `同步失败（HTTP ${String(res.status)}）`)
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }, [load])

  return (
    <div className={css.page}>
      <header className={css.head}>
        <h3 className={css.title}>用量与配额</h3>
        <span className={css.hint}>
          {view?.available === true && view.period !== ''
            ? `本周期 ${view.period}`
            : '还没从平台拉到配额'}
        </span>
      </header>

      {view === null || !view.available ? (
        <p className={css.empty}>
          {view === null ? '正在读取配额…' : `${view.note}。`}
        </p>
      ) : (
        <>
          <div className={css.verdictRow}>
            <Tag tone={view.verdict === 'exceeded' ? 'danger' : view.verdict === 'within' ? 'success' : 'neutral'}>
              {view.note}
            </Tag>
            <span className={css.hint}>以平台为准，本地只展示、不阻断</span>
          </div>

          <ul className={css.rows}>
            {view.rows.map((row) => {
              const ratio = ratioOf(row)
              return (
                <li key={row.key} className={css.row}>
                  <span className={css.rowHead}>
                    <span className={css.label}>{row.label}</span>
                    <span className={row.exceeded ? css.valueExceeded : css.value}>
                      {formatNumber(row.used)}
                      {row.limit === undefined ? ' / 未设限' : ` / ${formatNumber(row.limit)}`}
                    </span>
                  </span>
                  {ratio === undefined ? (
                    <span className={css.barEmpty} aria-hidden="true" />
                  ) : (
                    <span className={css.bar} aria-hidden="true">
                      <span
                        className={row.exceeded ? css.barFillExceeded : css.barFill}
                        style={{ width: `${String(Math.round(ratio * 100))}%` }}
                      />
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void sync()}>
          {busy ? '同步中…' : '同步配额'}
        </Button>
        {note !== null ? <span className={css.hint}>{note}</span> : null}
      </div>
      {error !== null ? <p className={css.error}>{error}</p> : null}
    </div>
  )
}
