import { useCallback, useEffect, useState } from 'react'
import { Button, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { IM_BINDINGS_ROUTE, IM_CHANNELS, type ImBindingView } from '../bindings.ts'
import css from './LoginPage.module.css'

interface BindingsPayload {
  ok: boolean
  bindings?: ImBindingView[]
  binding?: ImBindingView | null
  message?: string
}

async function call(url: string, init?: RequestInit): Promise<BindingsPayload> {
  try {
    const res = await fetch(url, init)
    return (await res.json()) as BindingsPayload
  } catch (error) {
    return { ok: false, message: String((error as Error)?.message ?? error) }
  }
}

/**
 * IM 绑定（飞书 / 钉钉 / 企业微信）：列我的、绑一个、解绑。
 * 全程走**宿主代理** `/api/office/im-bindings`（令牌不过浏览器）。
 */
export function ImBindings({ active }: { active: boolean }) {
  const [rows, setRows] = useState<readonly ImBindingView[]>([])
  const [channel, setChannel] = useState<string>('feishu')
  const [openId, setOpenId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const payload = await call(IM_BINDINGS_ROUTE)
    if (payload.ok) {
      setRows(payload.bindings ?? [])
      setError(null)
    } else {
      setError(payload.message ?? '读取绑定失败')
    }
  }, [])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  const info = IM_CHANNELS.find((item) => item.channel === channel) ?? IM_CHANNELS[0]

  const bind = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNote(null)
    const payload = await call(IM_BINDINGS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, openId }),
    })
    setBusy(false)
    if (payload.ok) {
      setNote('已绑定')
      setOpenId('')
      await refresh()
    } else {
      setError(payload.message ?? '绑定失败')
    }
  }, [channel, openId, refresh])

  const unbind = useCallback(async (id: string) => {
    setError(null)
    setNote(null)
    const payload = await call(`${IM_BINDINGS_ROUTE}?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (payload.ok) {
      setNote('已解绑')
      await refresh()
    } else {
      setError(payload.message ?? '解绑失败')
    }
  }, [refresh])

  if (!active) return null

  return (
    <div className={css.bindings}>
      <div className={css.userLine}>
        IM 绑定
        <span className={css.muted}>{'　消息会转到本机 agent（绑定后发消息即可）'}</span>
      </div>
      {rows.length === 0 ? (
        <span className={css.muted}>还没有绑定。</span>
      ) : (
        <ul className={css.bindingList}>
          {rows.map((row) => (
            <li key={row.id} className={css.bindingRow}>
              <span>
                <b>{row.channelLabel}</b>{' '}
                <span className={css.muted}>{row.idKind}</span> {row.openId}
              </span>
              <Button variant="outline" size="sm" onClick={() => void unbind(row.id)}>
                解绑
              </Button>
            </li>
          ))}
        </ul>
      )}
      <SegmentedControl
        id="im-channel"
        label="IM 渠道"
        value={channel}
        options={IM_CHANNELS.map((item) => ({ value: item.channel, label: item.label }))}
        onChange={setChannel}
      />
      <label className={css.field}>
        {`${info.label} ${info.idKind}`}
        <Input value={openId} onChange={(event) => setOpenId(event.target.value)} placeholder={info.placeholder} />
      </label>
      <span className={css.muted}>{info.hint}</span>
      <div>
        <Button variant="primary" size="sm" disabled={busy || openId.trim() === ''} onClick={() => void bind()}>
          {busy ? '绑定中…' : '绑定'}
        </Button>
      </div>
      {note !== null ? <span className={css.muted}>{note}</span> : null}
      {error !== null ? <span className={css.errorText}>{error}</span> : null}
    </div>
  )
}
