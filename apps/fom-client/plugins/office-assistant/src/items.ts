/**
 * 「日常事项」域的**纯逻辑层**（不碰 ctx、不碰 IO，便于单测）。
 *
 * 语义边界（设计 §2 D-9）：本域是**我的日常事项**（跨会话、跨重启），与内核
 * `todo_write`（某个会话里「这轮怎么干」的步骤清单）**并存、互不覆盖**；
 * 面板提供一键「从当前会话抄进来」，但绝不做自动双向同步。
 */

/** 事项状态（D-5：只两态 + 到期标记）。 */
export type ItemStatus = 'open' | 'done'

/** 来源。 */
export type ItemSource = 'panel' | 'tool' | 'im'

/** 一条日常事项（**正文只在本机**，见 D-3）。 */
export interface AssistantItem {
  readonly id: string
  readonly text: string
  readonly status: ItemStatus
  /** UTC 毫秒。 */
  readonly createdAt: number
  readonly updatedAt: number
  /** 可选到期时刻（UTC 毫秒）；v1 只做标记、不推送。 */
  readonly dueAt?: number
  readonly doneAt?: number
  readonly source: ItemSource
  /** 可选来源会话（「抄进来」用；不参与分组）。 */
  readonly sessionId?: string
}

/** 正文上限（字符）。 */
export const MAX_TEXT = 500
/** 单域条数上限（D-7）。 */
export const MAX_ITEMS = 5_000
/** 已完成保留天数（D-7）。 */
export const DONE_RETENTION_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1_000

/** 归一正文：trim + 折叠连续空白。 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/gu, ' ')
}

/** 校验正文：空/超长 ⇒ 错误文案；合法 ⇒ `undefined`。 */
export function textError(text: string): string | undefined {
  const normalized = normalizeText(text)
  if (normalized === '') return '写点什么'
  if ([...normalized].length > MAX_TEXT) return `最多 ${MAX_TEXT} 字`
  return undefined
}

/**
 * 造一条新事项。
 * @param input 正文 / 来源 / 可选到期与会话
 * @param now 当前时刻（UTC 毫秒，注入便于测试）
 * @param id 可注入 id（缺省由调用方给）
 * @returns 新行（未持久化）
 */
export function newItem(
  input: { text: string; source?: ItemSource; dueAt?: number; sessionId?: string },
  now: number,
  id: string,
): AssistantItem {
  const text = normalizeText(input.text)
  const error = textError(text)
  if (error !== undefined) throw new Error(error)
  const item: AssistantItem = {
    id,
    text,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    source: input.source ?? 'panel',
  }
  return {
    ...item,
    ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  }
}

/** 勾选/取消勾选（写 `doneAt` 与 `updatedAt`）。 */
export function toggle(item: AssistantItem, now: number): AssistantItem {
  if (item.status === 'open') {
    return { ...item, status: 'done', doneAt: now, updatedAt: now }
  }

  const next: AssistantItem = { ...item, status: 'open', updatedAt: now }
  // `doneAt` 可空：显式去掉，避免 schema 里留下「未完成却有完成时间」的歧义。
  const { doneAt: _doneAt, ...rest } = next
  return rest
}

/** 改正文（trim + 校验）。 */
export function edit(item: AssistantItem, text: string, now: number): AssistantItem {
  const normalized = normalizeText(text)
  const error = textError(normalized)
  if (error !== undefined) throw new Error(error)
  return { ...item, text: normalized, updatedAt: now }
}

/** 排序（D-6）：未完成在前；有到期按到期升序；同档按更新时间降序。 */
export function sortItems(items: readonly AssistantItem[]): AssistantItem[] {
  const rank = (item: AssistantItem): number => (item.status === 'open' ? 0 : 1)
  return [...items].sort((left, right) => {
    if (rank(left) !== rank(right)) return rank(left) - rank(right)
    if (left.status === 'open') {
      const leftDue = left.dueAt ?? Number.POSITIVE_INFINITY
      const rightDue = right.dueAt ?? Number.POSITIVE_INFINITY
      if (leftDue !== rightDue) return leftDue - rightDue
    }

    return right.updatedAt - left.updatedAt
  })
}

/** 该清掉哪些（D-7）：已完成且 `doneAt` 早于保留期。返回 id 列表（不改入参）。 */
export function prunable(
  items: readonly AssistantItem[],
  now: number,
  retentionDays = DONE_RETENTION_DAYS,
): string[] {
  const cutoff = now - retentionDays * DAY_MS
  return items
    .filter((item) => item.status === 'done' && (item.doneAt ?? item.updatedAt) < cutoff)
    .map((item) => item.id)
}

/** 到期标记（v1 只用于显示）：未完成且 `dueAt <= now`。 */
export function isOverdue(item: AssistantItem, now: number): boolean {
  return item.status === 'open' && item.dueAt !== undefined && item.dueAt <= now
}

/**
 * 「从当前会话的 todo 抄进来」（D-9）：只抄未完成的、按「正文 + 未完成」去重。
 * @param todos 会话投影里的待办（`content` + `status`，内核 `todo_write` 的形状）
 * @param existing 已有事项
 * @param now 当前时刻
 * @param idOf 造 id（注入便于测试）
 * @returns 需要新建的行（已存在的跳过）
 */
export function copyFromSessionTodos(
  todos: readonly { readonly content: string; readonly status: string }[],
  existing: readonly AssistantItem[],
  now: number,
  idOf: () => string,
): AssistantItem[] {
  const seen = new Set(
    existing.filter((item) => item.status === 'open').map((item) => normalizeText(item.text)),
  )
  const created: AssistantItem[] = []
  for (const todo of todos) {
    if (todo.status !== 'pending' && todo.status !== 'in_progress') continue
    const text = normalizeText(todo.content)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    created.push(newItem({ text, source: 'panel' }, now, idOf()))
  }

  return created
}
