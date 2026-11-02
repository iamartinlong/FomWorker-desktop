/**
 * 「我的待办」块的**视图纯逻辑**（不碰 React / fetch，便于单测）。
 *
 * 与 `items.ts` 的分工：那边是数据语义（造/勾/改/排序/清理），这边只做**展示分组**——
 * 哪个进「待办」、哪个进「已完成」、折叠里几条、到期怎么标。
 */
import { isOverdue, type AssistantItem } from '../items.ts'

/** 面板要渲染的两组。 */
export interface ItemGroups {
  readonly open: AssistantItem[]
  readonly done: AssistantItem[]
}

/**
 * 分组：未完成进主列表、已完成进折叠区（**保持传入顺序**——顺序由 `sortItems` 定）。
 * @param items 已经排好序的事项
 */
export function groupItems(items: readonly AssistantItem[]): ItemGroups {
  return {
    open: items.filter((item) => item.status === 'open'),
    done: items.filter((item) => item.status === 'done'),
  }
}

/** 一行的副标题：到期/已完成时间（没有就是空串）。 */
export function itemMeta(item: AssistantItem, now: number): string {
  if (item.status === 'done') {
    return item.doneAt === undefined ? '已完成' : `已完成 · ${formatDate(item.doneAt)}`
  }

  if (item.dueAt === undefined) return ''
  return isOverdue(item, now) ? `已过期 · ${formatDate(item.dueAt)}` : `到期 · ${formatDate(item.dueAt)}`
}

/** 本地化时间（`MM-DD HH:mm`；跨年补年份）。 */
export function formatDate(ms: number, now = Date.now()): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return sameYear ? day : `${date.getFullYear()}-${day}`
}

/** 折叠区的标题文案（含条数）。 */
export function doneLabel(count: number): string {
  return `已完成（${count}）`
}
