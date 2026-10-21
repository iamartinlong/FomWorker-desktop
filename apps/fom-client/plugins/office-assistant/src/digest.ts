/**
 * 「日终收拢」的**纯逻辑层**（不碰 ctx、不碰 IO，便于单测）。
 *
 * 口径（设计 S5）：把**当天**的日常事项 + 会话待办收成一条简报，落在本机；
 * **空集不出版**（一条都没有就不写、也不给空卡片）。
 *
 * 为什么不用模型写正文：简报要**确定性**（同一份输入永远同一份输出、可单测、可对账），
 * 且 D-3 要求正文只在本机。模型润色属可选增强，不放进这条基线。
 */
import { isOverdue, type AssistantItem } from './items.ts'

/** 简报正文最多列几条事项（其余折叠成一行计数）。 */
export const MAX_DIGEST_LINES = 12

/** 会话待办（内核 `todo_write` 投影的最小面）。 */
export interface DigestSessionTodo {
  readonly content: string
  readonly status: string
}

/** 造简报的输入。 */
export interface DigestInput {
  /** 日常事项（跨会话，域里全部）。 */
  readonly items: readonly AssistantItem[]
  /** 会话待办（可选：读不到就是没有）。 */
  readonly todos?: readonly DigestSessionTodo[]
  /** 当前时刻（UTC 毫秒）。 */
  readonly now: number
}

/** 一条日终简报（正文只在本机）。 */
export interface AssistantDigest {
  /** `YYYY-MM-DD`（本地日期，一天一条）。 */
  readonly id: string
  readonly date: string
  readonly createdAt: number
  /** 未完成条数。 */
  readonly openCount: number
  /** 今天完成的条数。 */
  readonly doneToday: number
  /** 其中已逾期的条数。 */
  readonly overdueCount: number
  /** 分行正文（面板按行渲染）。 */
  readonly lines: readonly string[]
  /** 整段正文（`lines` 用换行拼起来）。 */
  readonly text: string
}

/** 本地日期键 `YYYY-MM-DD`。 */
export function dateKeyOf(now: number): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/** 本地当天 00:00（UTC 毫秒）。 */
export function startOfDay(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 下一次到点（本地 `hour:00`）的时刻；已过今天就顺延到明天。 */
export function nextDigestAt(now: number, hour: number): number {
  const clamped = Math.min(23, Math.max(0, Math.trunc(hour)))
  const target = new Date(now)
  target.setHours(clamped, 0, 0, 0)
  if (target.getTime() <= now) target.setDate(target.getDate() + 1)
  return target.getTime()
}

/** 简报该不该出：输入里**一条可说的都没有** ⇒ `undefined`。 */
export function buildDigest(input: DigestInput): AssistantDigest | undefined {
  const { items, now } = input
  const todos = input.todos ?? []
  const dayStart = startOfDay(now)

  const open = items.filter((item) => item.status === 'open')
  const doneToday = items.filter(
    (item) => item.status === 'done' && (item.doneAt ?? item.updatedAt) >= dayStart,
  )
  const overdue = open.filter((item) => isOverdue(item, now))
  const pendingTodos = todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress')

  // 空集不出版：今天没完成、也没欠着、会话里也没有残留步骤。
  if (open.length === 0 && doneToday.length === 0 && pendingTodos.length === 0) return undefined

  const lines: string[] = []

  if (doneToday.length > 0) {
    const names = doneToday.slice(0, 3).map((item) => item.text).join('、')
    lines.push(`今天完成 ${doneToday.length} 条：${names}${doneToday.length > 3 ? ' 等' : ''}`)
  }

  if (open.length === 0) {
    lines.push('待办已清空')
  } else {
    lines.push(
      overdue.length > 0
        ? `还有 ${open.length} 条没做完，其中 ${overdue.length} 条已逾期`
        : `还有 ${open.length} 条没做完`,
    )
    for (const item of open.slice(0, MAX_DIGEST_LINES)) {
      lines.push(`· ${isOverdue(item, now) ? '[逾期] ' : ''}${item.text}`)
    }

    if (open.length > MAX_DIGEST_LINES) lines.push(`…还有 ${open.length - MAX_DIGEST_LINES} 条`)
  }

  if (pendingTodos.length > 0) lines.push(`会话里还有 ${pendingTodos.length} 条未完成步骤`)

  const date = dateKeyOf(now)
  return {
    id: date,
    date,
    createdAt: now,
    openCount: open.length,
    doneToday: doneToday.length,
    overdueCount: overdue.length,
    lines,
    text: lines.join('\n'),
  }
}
