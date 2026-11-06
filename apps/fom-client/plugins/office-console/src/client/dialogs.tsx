/**
 * 控制台的三个**对话框**（`ui-primitives` 的 `Modal`）：新建技能 / 新建专家 / 导入（技能或专家）。
 *
 * 口径（见 `前端技术栈与页面实现规范v0.1` §3.9/§3.10）：工具栏行只留**操作按钮**，表单进**对话框**；
 * **关了就卸载**；字段**标签式**（label 在上，placeholder 只留示例）；**提交前做前端必填/格式校验**
 * （`validate.ts`）——不把坏输入打到后端；宿主的**权威**校验失败（400）**显示在对话框里**，不落页面通知。
 */

import { useRef, useState } from 'react'
import { Button, Checkbox, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { Textarea } from '@fominfo/dsh-ui'
import { checkImportFile, type ImportCheck, type ImportKind } from './import-check.ts'
import { hasErrors, validateExpertDraft, validateSkillDraft, type ExpertDraft, type FieldErrors, type SkillDraft } from './validate.ts'
import css from './ConsolePage.module.css'

export type { ExpertDraft, SkillDraft } from './validate.ts'

/** 提交结果（宿主的权威校验 / 写入结果）。 */
export interface SubmitResult {
  readonly ok: boolean
  readonly message: string
}

const EMPTY_SKILL: SkillDraft = { slug: '', name: '', description: '', body: '' }
const EMPTY_EXPERT: ExpertDraft = { id: '', name: '', description: '', personaPrefix: '', planMode: false, subagent: false }

/** 标签式字段（label 在上、错误在下）。 */
function Field({ label, error, children }: { label: string; error?: string | undefined; children: React.ReactNode }) {
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      {children}
      {error !== undefined ? <span className={css.fieldError}>{error}</span> : null}
    </label>
  )
}

/** 新建技能对话框。 */
export function CreateSkillDialog({ open, busy, onClose, onSubmit }: {
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (draft: SkillDraft) => Promise<SubmitResult>
}) {
  const [draft, setDraft] = useState<SkillDraft>(EMPTY_SKILL)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [server, setServer] = useState<SubmitResult | null>(null)
  const close = (): void => {
    setDraft(EMPTY_SKILL)
    setErrors({})
    setServer(null)
    onClose()
  }
  const submit = (): void => {
    setServer(null)
    const found = validateSkillDraft(draft)
    setErrors(found)
    if (hasErrors(found)) return
    void onSubmit(draft).then((result) => {
      if (!result.ok) setServer(result)
    })
  }
  return (
    <Modal
      open={open}
      onClose={close}
      title="新建技能"
      closeLabel="关闭"
      className={css.dialog}
      footer={(
        <>
          <Button variant="outline" onClick={close}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>{busy ? '创建中…' : '创建'}</Button>
        </>
      )}
    >
      <div className={css.form}>
        <Field label="标识 slug（小写字母/数字开头，可含 . _ -）" error={errors.slug}>
          <Input data-modal-autofocus placeholder="例：meeting-minutes" value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
        </Field>
        <Field label="名称" error={errors.name}>
          <Input placeholder="例：会议纪要分发" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="一句话说明（可选）">
          <Input placeholder="例：把会议记录整理成结构化纪要" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </Field>
        <Field label="技能正文（SKILL.md 指令）" error={errors.body}>
          <Textarea placeholder="给模型的指令正文…" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={8} />
        </Field>
        {server !== null && !server.ok ? <Tag tone="danger">{server.message}</Tag> : null}
      </div>
    </Modal>
  )
}

/** 新建专家对话框。 */
export function CreateExpertDialog({ open, busy, onClose, onSubmit }: {
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (draft: ExpertDraft) => Promise<SubmitResult>
}) {
  const [draft, setDraft] = useState<ExpertDraft>(EMPTY_EXPERT)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [server, setServer] = useState<SubmitResult | null>(null)
  const close = (): void => {
    setDraft(EMPTY_EXPERT)
    setErrors({})
    setServer(null)
    onClose()
  }
  const submit = (): void => {
    setServer(null)
    const found = validateExpertDraft(draft)
    setErrors(found)
    if (hasErrors(found)) return
    void onSubmit(draft).then((result) => {
      if (!result.ok) setServer(result)
    })
  }
  return (
    <Modal
      open={open}
      onClose={close}
      title="新建专家"
      closeLabel="关闭"
      className={css.dialog}
      footer={(
        <>
          <Button variant="outline" onClick={close}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>{busy ? '创建中…' : '创建'}</Button>
        </>
      )}
    >
      <div className={css.form}>
        <Field label="标识 id（小写字母/数字开头，可含 . _ -）" error={errors.id}>
          <Input data-modal-autofocus placeholder="例：contract-reviewer" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
        </Field>
        <Field label="名称" error={errors.name}>
          <Input placeholder="例：合同审阅官" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="一句话说明（可选）">
          <Input placeholder="例：逐条比对合同条款与法务红线" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </Field>
        <Field label="人设（可选：是谁 + 什么背景 + 擅长什么）">
          <Input placeholder="例：你是资深法务，擅长合同风险识别" value={draft.personaPrefix} onChange={(e) => setDraft({ ...draft, personaPrefix: e.target.value })} />
        </Field>
        <Checkbox checked={draft.planMode} label="开启「规划模式」（plan-mode）" onChange={(next) => setDraft({ ...draft, planMode: next })} />
        <Checkbox checked={draft.subagent} label="开启「子代理委派」（tool-subagent）" onChange={(next) => setDraft({ ...draft, subagent: next })} />
        <span className={css.hint}>提示：也可以直接在对话里说「帮我创建一个专家」，由 AI 引导创建。</span>
        {server !== null && !server.ok ? <Tag tone="danger">{server.message}</Tag> : null}
      </div>
    </Modal>
  )
}

/** 导入对话框（技能 / 专家）：格式说明 + 选文件 + 浅检结果 + 宿主结果。 */
export function ImportDialog({ kind, open, busy, onClose, onImport }: {
  kind: ImportKind
  open: boolean
  busy: boolean
  onClose: () => void
  onImport: (bundle: unknown) => Promise<SubmitResult>
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<{ name: string; size: number } | null>(null)
  const [check, setCheck] = useState<ImportCheck | null>(null)
  const [bundle, setBundle] = useState<unknown>(null)
  const [server, setServer] = useState<SubmitResult | null>(null)

  const close = (): void => {
    setFile(null)
    setCheck(null)
    setBundle(null)
    setServer(null)
    onClose()
  }
  const pick = (chosen: File): void => {
    setServer(null)
    setFile({ name: chosen.name, size: chosen.size })
    void chosen.text().then((text) => {
      const result = checkImportFile(kind, text)
      setCheck(result)
      try {
        setBundle(result.ok ? JSON.parse(text) : null)
      } catch {
        setBundle(null)
      }
    }).catch(() => {
      setCheck({ ok: false, message: '读取文件失败' })
      setBundle(null)
    })
  }

  const label = kind === 'skill' ? '技能' : '专家'
  const expectedKind = kind === 'skill' ? 'fom-skill' : 'fom-expert'
  const fields = kind === 'skill' ? 'slug / name / body' : 'id / name'

  return (
    <Modal
      open={open}
      onClose={close}
      title={`导入${label}`}
      closeLabel="关闭"
      className={css.dialog}
      footer={(
        <>
          <Button variant="outline" onClick={close}>取消</Button>
          <Button
            variant="primary"
            disabled={busy || check?.ok !== true}
            onClick={() => {
              void onImport(bundle).then((result) => {
                setServer(result)
              })
            }}
          >
            {busy ? '导入中…' : '导入'}
          </Button>
        </>
      )}
    >
      <div className={css.form}>
        <p className={css.hint}>
          {`格式：单文件 JSON —— kind 为 ${expectedKind}、version 为 1，必备字段 ${fields}。`}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const chosen = e.target.files?.[0]
            if (chosen !== undefined) pick(chosen)
            e.target.value = ''
          }}
        />
        <div className={css.fileRow}>
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>选择文件…</Button>
          <span className={css.fileName}>{file === null ? '未选择文件' : `${file.name}（${file.size} B）`}</span>
        </div>
        {check !== null ? <Tag tone={check.ok ? 'success' : 'danger'}>{check.message}</Tag> : null}
        {server !== null && !server.ok ? <Tag tone="danger">{server.message}</Tag> : null}
      </div>
    </Modal>
  )
}
