/**
 * `schedule.json` 的**内核形状**唯一生产者 —— 自证与探针都从这里取，不在各自文件里另抄一份形状。
 *
 * 形状依据（不是「判定想读什么就写什么」）：
 * - `schedule` 那条域没有 `layout` ⇒ 整份文档一个信封 `{unit, global, tables}`，任务行挂在
 *   `tables.tasks` 下按 jobId 索引（本机真文档核过键名）。
 * - `daily` 那一形的 record 列集合＝`packages/schedule/schedule/src/types.ts:63-79`
 *   的 `DailyScheduleRecord`；`at` 那一形＝同文件 `:33-45`（没有 `at` 列，目标时刻就是 `scheduledAt`）。
 * - `status` 在 schema 里带 default ⇒ 磁盘上**可以整列不写**（`status: null` 那一臂）。
 *
 * 换形时最响的信号在探针那里（它把列集合与 `DailyScheduleRecord` 逐字比），不靠肉眼读键名。
 */
import fs from 'node:fs'
import { DISTILL_PROMPT, DISTILL_TIME, DISTILL_TIME_ZONE, DISTILL_TITLE } from '../plugins/office-memory/arm.ts'

/** 内核 `DailyScheduleRecord` 的列集合（缺列＝判据读那列会静默读成空串，多列＝这份文档不是这版内核写的）。 */
export const DAILY_RECORD_KEYS: readonly string[] = ['id', 'kind', 'prompt', 'scheduledAt', 'time', 'timeZone', 'title']

export interface JobSpec {
  readonly jobId: string
  /** `daily`（夜间蒸馏那一形）或 `at`（审批层催办那一形，本机 39 行全是这形）。默认 `daily`。 */
  readonly shape?: 'daily' | 'at'
  /** 覆盖 `record.kind`（`kind` 漂移那一臂，如内核写出 `cron` 或这一行被改形）。 */
  readonly kind?: string
  readonly title?: string
  readonly prompt?: string
  readonly time?: string
  readonly timeZone?: string
  /** `null` ＝整列不写（内核 schema 的 default 列）。 */
  readonly status?: string | null
  /** 故意**少写**的 record 列（形状漂移那一臂）。 */
  readonly drop?: readonly string[]
  /** 故意**多写**的 record 列（形状漂移那一臂）。 */
  readonly extra?: Record<string, unknown>
}

const dropped = (spec: JobSpec, key: string): boolean => (spec.drop ?? []).includes(key)

function recordOf(spec: JobSpec): Record<string, unknown> {
  const shape = spec.shape ?? 'daily'
  const base: Record<string, unknown> = shape === 'at'
    ? {
        id: spec.jobId,
        kind: spec.kind ?? 'at',
        title: spec.title ?? '审批催办',
        prompt: spec.prompt ?? '催办正文（与夜间蒸馏无关，正文里带 ops_password 也不会被认出来）',
        scheduledAt: '2026-10-11T12:00:00.000Z',
      }
    : {
        id: spec.jobId,
        kind: spec.kind ?? 'daily',
        title: spec.title ?? DISTILL_TITLE,
        prompt: spec.prompt ?? DISTILL_PROMPT,
        time: spec.time ?? DISTILL_TIME,
        timeZone: spec.timeZone ?? DISTILL_TIME_ZONE,
        scheduledAt: '2026-11-02T03:30:00.000Z',
      }
  return { ...base, ...(spec.extra ?? {}) }
}

/** 按内核落盘形状写一份 `schedule.json`；`jobs` 里每行都带 `sessionId` 与空投递史。 */
export function writeSchedule(file: string, jobs: readonly JobSpec[]): void {
  const tasks: Record<string, unknown> = {}
  jobs.forEach(job => {
    const record = Object.fromEntries(
      Object.entries(recordOf(job)).filter(([key]) => !dropped(job, key)),
    )
    tasks[job.jobId] = {
      sessionId: 'sess-distiller-top',
      record,
      ...(job.status === null ? {} : { status: job.status ?? 'active' }),
      deliveryHistory: { records: [] },
    }
  })
  const doc = { unit: { name: 'schedule', version: 1 }, global: {}, tables: { tasks } }
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

/** 写一份**故意不是这个形状**的文档（缺 `tables.tasks`／非法 JSON 之类），探针要能对坏信封出声。 */
export function writeRawScheduleDoc(file: string, text: string): void {
  fs.writeFileSync(file, text, 'utf8')
}
