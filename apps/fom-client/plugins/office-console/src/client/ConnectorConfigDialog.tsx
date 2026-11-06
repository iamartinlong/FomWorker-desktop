/**
 * **连接器配置对话框**（T6）：一个组件覆盖两种场景——
 *
 * ① **配置平台层连接器**（如飞书）：`GET ?slug=connector:feishu` 拿表单与现值 ⇒ `POST op:configure`
 * ② **新建用户自建 MCP**：`GET ?new=1[&transport=…]` 拿表单 ⇒ `POST op:create`
 *
 * 形态照 `dialogs.tsx` 那三个对话框（`ui-primitives` 的 `Modal`）：关了就卸载、标签式字段、
 * 前端先做必填校验、宿主的 400 显示在对话框里不落页面通知。
 *
 * **表单由服务端给**（字段数组），本组件只按 `type` 渲染——所以加一种字段类型不用改这里，
 * 加一个连接器也不用改这里（服务端 `PLUGIN_FORMS` / `mcpConfigForm` 的事）。
 * 传输类型变化时**重新拉表单**（字段集会变），这是「按传输显隐」的落地方式。
 */

import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { Textarea } from '@fominfo/dsh-ui'
import css from './ConsolePage.module.css'

/** 服务端下发的字段形状（与 host 侧 `connector-form.ts` 逐键对应）。 */
interface FormField {
  readonly key: string
  readonly label: string
  readonly type: 'text' | 'secret' | 'boolean' | 'list' | 'keyvalue' | 'select'
  readonly required?: boolean
  readonly placeholder?: string
  readonly hint?: string
  readonly default?: unknown
  readonly options?: readonly { readonly value: string; readonly label: string }[]
  readonly storeAs?: string
  readonly secretValues?: boolean
}

type Values = Record<string, unknown>

/** 标签式字段（label 在上、错误在下）。 */
function Field({ label, error, hint, children }: { label: string; error?: string | undefined; hint?: string; children: React.ReactNode }) {
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      {children}
      {hint !== undefined ? <span className={css.hint}>{hint}</span> : null}
      {error !== undefined ? <span className={css.fieldError}>{error}</span> : null}
    </label>
  )
}

/** 键值对编辑器（`env` / `headers`）：一行一个键值，secret 值打码显示。 */
function KeyValueEditor({ value, secret, onChange }: { value: unknown; secret: boolean; onChange: (next: Record<string, string>) => void }) {
  const pairs = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, string>) : {}
  const entries = Object.entries(pairs)
  const [draftKey, setDraftKey] = useState('')
  const [draftValue, setDraftValue] = useState('')
  const commit = (key: string, val: string): void => {
    const next = { ...pairs }
    if (key === '') return
    next[key] = val
    onChange(next)
  }
  return (
    <div className={css.kv}>
      {entries.map(([k, v]) => (
        <div key={k} className={css.kvRow}>
          <Input value={k} readOnly />
          <Input value={secret ? '••••••••' : v} placeholder={secret ? '已保存' : '值'} onChange={(e) => commit(k, e.target.value)} />
          <Button variant="ghost" size="sm" onClick={() => { const next = { ...pairs }; delete next[k]; onChange(next) }}>删</Button>
        </div>
      ))}
      <div className={css.kvRow}>
        <Input placeholder="键" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} />
        <Input placeholder="值" value={draftValue} onChange={(e) => setDraftValue(e.target.value)} />
        <Button variant="ghost" size="sm" onClick={() => { commit(draftKey.trim(), draftValue); setDraftKey(''); setDraftValue('') }}>加</Button>
      </div>
    </div>
  )
}

/** 按字段类型渲染一个输入控件。 */
function FieldControl({ field, value, onChange }: { field: FormField; value: unknown; onChange: (next: unknown) => void }) {
  if (field.type === 'boolean') {
    return <Checkbox checked={value === true} label={field.placeholder ?? '开启'} onChange={(next) => onChange(next)} />
  }
  if (field.type === 'select') {
    return (
      <select className={css.select} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">请选择</option>
        {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  }
  if (field.type === 'list') {
    const items = Array.isArray(value) ? (value as string[]) : []
    return (
      <Textarea
        rows={3}
        placeholder="每行一个"
        value={items.join('\n')}
        onChange={(e) => onChange(e.target.value.split('\n').map((line) => line.trim()).filter((line) => line !== ''))}
      />
    )
  }
  if (field.type === 'keyvalue') {
    return <KeyValueEditor value={value} secret={field.secretValues === true} onChange={(next) => onChange(next)} />
  }
  return (
    <Input
      type={field.type === 'secret' ? 'password' : 'text'}
      placeholder={field.placeholder}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** 连接器配置 / 新建对话框。 */
export function ConnectorConfigDialog({ open, busy, mode, slug, onClose, onDone }: {
  open: boolean
  busy: boolean
  /** `configure`＝配平台层条目；`create`＝新建用户自建 MCP。 */
  mode: 'configure' | 'create'
  /** `configure` 时的条目 id（如 `connector:feishu`）。 */
  slug?: string
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [fields, setFields] = useState<readonly FormField[]>([])
  const [values, setValues] = useState<Values>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [server, setServer] = useState<string | null>(null)
  const [restart, setRestart] = useState(false)
  const [loading, setLoading] = useState(false)

  // 打开时拉表单（传输变化时也重拉——字段集会变）
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setServer(null)
    setErrors({})
    const transport = typeof values.transport === 'string' ? values.transport : undefined
    const url = mode === 'create'
      ? `/api/office/connector?new=1${transport === undefined ? '' : `&transport=${encodeURIComponent(transport)}`}`
      : `/api/office/connector?slug=${encodeURIComponent(slug ?? '')}`
    void (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' })
        const body = await res.json() as { ok?: boolean; form?: readonly FormField[]; values?: Values }
        if (!alive) return
        setFields(body.form ?? [])
        setValues((prev) => ({ ...(body.values ?? {}), ...(mode === 'create' ? { transport: prev.transport } : {}) }))
      } catch (e) {
        if (alive) setServer(`读取表单失败：${String((e as Error)?.message ?? e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
    // 传输变化要重拉 ⇒ 依赖里放它
  }, [open, mode, slug, typeof values.transport === 'string' ? values.transport : ''])

  const submit = (): void => {
    setServer(null)
    // 前端必填校验（与 host 侧 missingRequired 同口径：空串/空白算没填）
    const found: Record<string, string> = {}
    for (const f of fields) {
      if (f.required !== true || f.type === 'boolean' || f.type === 'select') continue
      const v = values[f.key]
      const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
        || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && Object.keys(v).length === 0)
      if (empty) found[f.key] = `请填写${f.label}`
    }
    setErrors(found)
    if (Object.keys(found).length > 0) return
    void (async () => {
      try {
        const res = await fetch('/api/office/connector', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(mode === 'create' ? { op: 'create', ...values } : { op: 'configure', id: slug, ...values }),
        })
        const body = await res.json() as { ok?: boolean; error?: string; missing?: readonly string[]; restartRequired?: boolean }
        if (body.ok === true) {
          setRestart(body.restartRequired === true)
          onDone(mode === 'create' ? '连接器已创建' : '配置已保存')
          return
        }
        // 宿主的 400（含 missing）落回字段
        if (Array.isArray(body.missing)) {
          const next: Record<string, string> = {}
          for (const label of body.missing) {
            const f = fields.find((item) => item.label === label)
            if (f !== undefined) next[f.key] = `请填写${label}`
          }
          setErrors(next)
        }
        setServer(body.error ?? `失败：HTTP ${res.status}`)
      } catch (e) {
        setServer(`提交失败：${String((e as Error)?.message ?? e)}`)
      }
    })()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? '新建连接器（自定义 MCP）' : `配置连接器 · ${slug ?? ''}`}
      closeLabel="关闭"
      className={css.dialog}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy || loading} onClick={submit}>{busy ? '保存中…' : '保存'}</Button>
        </>
      )}
    >
      <div className={css.form}>
        {loading ? <span className={css.hint}>读取表单…</span> : null}
        {fields.map((f) => (
          <Field key={f.key} label={f.required === true ? `${f.label} *` : f.label} error={errors[f.key]} hint={f.hint}>
            <FieldControl
              field={f}
              value={values[f.key]}
              onChange={(next) => {
                if (f.key === 'transport') {
                  // 传输变了 ⇒ 只留传输本身，其余字段值清空（字段集合马上会重拉）
                  setValues({ transport: next })
                  return
                }
                setValues((prev) => ({ ...prev, [f.key]: next }))
              }}
            />
          </Field>
        ))}
        {restart ? <Tag tone="warning">已保存，重启应用后生效</Tag> : null}
        {server !== null ? <Tag tone="danger">{server}</Tag> : null}
      </div>
    </Modal>
  )
}
