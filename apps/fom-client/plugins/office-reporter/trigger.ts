/**
 * **折叠触发**（K3）：把**真会话日志**折成上报消息并冲队列。
 *
 * 读法复用 `office-meter/reader.ts`（同一 `$DSH_HOME/sessions` 布局、zstd 解码、每目录取最高代）；
 * **幂等由平台兜**——usage 键 `{tenant,user,session,turn,step,attempt}`，重放只会回 `duplicate=true`，
 * 所以重复 sync 是安全的。
 */

import { join } from 'node:path'
import { collectAudit, type AuditEntry } from '../office-audit/audit.ts'
import { readSessionLogs } from '../office-meter/reader.ts'
import { collectSession } from './collect.ts'
import type { ReportContext } from './messages.ts'
import type { Reporter } from './reporter.ts'

/**
 * **事件驱动触发**：把内核 `session/event` 的 `turn/end` 转成**防抖**的 sync 调用。
 * 只认 `turn/end`（一个轮次刚结束、用量/审计已落日志）；窗口内的多次触发合成一次。
 * @param deps.sync - 真正要跑的动作（通常 `syncSessionLogs(...)` 的闭包）。
 * @param deps.debounceMs - 防抖窗口（缺省 800）。
 * @param deps.blocked - 退避探测（缺省不拦）：为真时**这次触发直接跳过**——平台限流给了
 * `Retry-After` 时别立刻再冲，等下一次 `turn/end` 或定时触发（消息留在队列，不丢）。
 * @returns `onEvent(type)` 喂事件类型 + `dispose()` 释放（取消未落地的定时器）。
 */
export function createTurnEndTrigger(deps: { sync: () => Promise<unknown>; debounceMs?: number; blocked?: () => boolean }): {
  onEvent: (type: unknown) => void
  dispose: () => void
} {
  const debounceMs = deps.debounceMs ?? 800
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    onEvent: (type) => {
      if (type !== 'turn/end') return
      if (deps.blocked?.() === true) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void deps.sync().catch(() => {
          /* 事件触发失败静默（消息留队列，下次再冲） */
        })
      }, debounceMs)
    },
    dispose: () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

/** 一次会话日志同步的结果。 */export interface SessionSyncResult {
  /** 扫到的会话数。 */
  readonly sessions: number
  /** 入队条数（用量 + 审计）。 */
  readonly reported: number
  /** 本次送出的条数。 */
  readonly sent: number
  /** 冲完仍待发条数（失败则 >0，留在队列重试）。 */
  readonly pending: number
  /** 本次前移了水位线的会话数（有新增审计条目的会话）。 */
  readonly audited: number
  /** 冲队列失败时的错误消息（**不抛**：消息留队列，下次再冲）。 */
  readonly error?: string
  /** 失败是限流时平台给的退避毫秒（`Retry-After`；没有 ⇒ 缺省）。 */
  readonly retryAfterMs?: number
}

/**
 * 扫一个 `$DSH_HOME` 的会话日志 → 折**用量**（每条调用）+ **审计**（按 `seq` 水位线**增量**）→ 入队 → 冲队列。
 *
 * - 用量：幂等由平台兜（键 `{tenant,user,session,turn,step,attempt}`）⇒ 重复 sync 安全。
 * - 审计：**只发 `seq > 水位线`** 的条目；水位线**仅在成功送出后**前移（失败不发、留队列）。
 * - **传输失败不抛**（离线容错：返回 `sent:0` + `pending>0` + `error`）。
 * @param reporter - 上报器。
 * @param home - `$DSH_HOME`（读其 `sessions/`）。
 * @param ctx - 租户/用户/来源/缺省模型。
 * @returns 会话数 / 入队数 / 送出数 / 待发数 / 前移水位线的会话数（+ 失败消息）。
 */
export async function syncSessionLogs(reporter: Reporter, home: string, ctx: ReportContext): Promise<SessionSyncResult> {
  const logSet = readSessionLogs(join(home, 'sessions'))
  const auditBySession = new Map<string, AuditEntry[]>()
  for (const entry of collectAudit(logSet, ctx.tenantId)) {
    const list = auditBySession.get(entry.sessionId)
    if (list === undefined) auditBySession.set(entry.sessionId, [entry])
    else list.push(entry)
  }

  let reported = 0
  /** 成功送出后才前移的水位线。 */
  const pendingWatermarks: Array<{ sessionId: string; seq: number }> = []
  for (const log of logSet.sessions) {
    const watermark = reporter.watermark(log.sessionId)
    const fresh = (auditBySession.get(log.sessionId) ?? []).filter((entry) => entry.seq > watermark)
    if (fresh.length > 0) {
      pendingWatermarks.push({ sessionId: log.sessionId, seq: Math.max(...fresh.map((entry) => entry.seq)) })
    }
    reported += collectSession(reporter, log.sessionId, log.records, ctx, fresh)
  }

  try {
    const flushed = await reporter.flush()
    for (const item of pendingWatermarks) reporter.advance(item.sessionId, item.seq)
    return { sessions: logSet.sessions.length, reported, sent: flushed.sent, pending: flushed.pending, audited: pendingWatermarks.length }
  } catch (error) {
    const hint = reporter.retryAfterMs()
    return {
      sessions: logSet.sessions.length,
      reported,
      sent: 0,
      pending: reporter.pendingCount(),
      audited: 0,
      error: String((error as Error)?.message ?? error),
      ...(hint === undefined ? {} : { retryAfterMs: hint }),
    }
  }
}
