/**
 * 「日终简报」的**落盘**（同域 `office_assistant_items` 的第二张表 `digests`）。
 *
 * 为什么与事项同域：两者同属「我的日常事项」这一块数据，一起打开/一起清理最省事，
 * 且 per-record 布局下新表不需要提升域版本（旧记录仍按 v1 读）。
 *
 * 键是**本地日期** `YYYY-MM-DD`：一天最多一条，重跑覆盖（幂等）。
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { AssistantDigest } from './digest.ts'
import type { AssistantItem } from './items.ts'
import { MAX_ITEMS, MAX_TEXT, edit, newItem, prunable, sortItems, toggle, type ItemSource } from './items.ts'

/** 简报正文上限（行长度 × 行数，留足余量）。 */
export const MAX_DIGEST_TEXT = 8_000
/** 保留多少天的简报（D-7 同口径：90 天）。 */
export const DIGEST_RETENTION_DAYS = 90

const digestSchema = z.object({
  id: z.string().min(1).max(32),
  date: z.string().min(1).max(32),
  createdAt: z.number().int().nonnegative(),
  openCount: z.number().int().nonnegative(),
  doneToday: z.number().int().nonnegative(),
  overdueCount: z.number().int().nonnegative(),
  lines: z.array(z.string().max(MAX_TEXT)).max(200),
  text: z.string().max(MAX_DIGEST_TEXT),
})

const itemSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(MAX_TEXT),
  status: z.enum(['open', 'done']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  dueAt: z.number().int().nonnegative().optional(),
  doneAt: z.number().int().nonnegative().optional(),
  source: z.enum(['panel', 'tool', 'im']),
  sessionId: z.string().max(100).optional(),
})

/**
 * 域：`office_assistant_items`（v1 / per-record）。
 *
 * `items` = 日常事项；`digests` = 日终简报（键为本地日期）。
 */
export const assistantItemsDomain = defineDomain({
  name: 'office_assistant_items',
  version: 1,
  layout: 'per-record',
  tables: {
    items: domainTable<string, AssistantItem>(itemSchema),
    digests: domainTable<string, AssistantDigest>(digestSchema),
  },
})

/** 域句柄类型。 */
export type AssistantItemsDomain = Domain<typeof assistantItemsDomain>

const DAY_MS = 24 * 60 * 60 * 1_000

/** 存储壳：域之上的一层薄 API（面板/工具都只用它）。 */
export class ItemStore {
  /** 单域条数上限（可注入：单测用小值，生产默认 5000）。 */
  private readonly maxItems: number

  constructor(
    private readonly domain: AssistantItemsDomain,
    options: { maxItems?: number } = {},
  ) {
    this.maxItems = options.maxItems ?? MAX_ITEMS
  }

  /** 全部事项（排序见 `sortItems`）。 */
  list(): AssistantItem[] {
    const table = this.domain.table('items')
    const rows: AssistantItem[] = []
    for (const key of table.keys()) {
      const row = table.get(key)
      if (row !== undefined) rows.push(row)
    }

    return sortItems(rows)
  }

  /** 单条。 */
  get(id: string): AssistantItem | undefined {
    return this.domain.table('items').get(id)
  }

  /**
   * 新增一条（超上限拒）。
   * @param text 正文
   * @param now 当前时刻（UTC 毫秒）
   * @param options 来源 / 到期 / 会话
   * @param idOf id 工厂（缺省随机 UUID）
   */
  async add(
    text: string,
    now: number,
    options: { source?: ItemSource; dueAt?: number; sessionId?: string } = {},
    idOf: () => string = () => crypto.randomUUID(),
  ): Promise<AssistantItem> {
    if (this.domain.table('items').size >= this.maxItems) {
      throw new Error(`事项已达上限（${this.maxItems} 条），先清理一些已完成事项`)
    }

    const item = newItem({ text, ...options }, now, idOf())
    await this.domain.table('items').put(item.id, item)
    return item
  }

  /** 勾选/取消（`update` 保证 CAS）。 */
  async toggle(id: string, now: number): Promise<AssistantItem | undefined> {
    const table = this.domain.table('items')
    if (table.get(id) === undefined) return undefined
    return table.update(id, (current) => toggle(current, now))
  }

  /** 改正文。 */
  async edit(id: string, text: string, now: number): Promise<AssistantItem | undefined> {
    const table = this.domain.table('items')
    if (table.get(id) === undefined) return undefined
    return table.update(id, (current) => edit(current, text, now))
  }

  /** 删除（物理删；已完成的历史由 `prune` 负责）。 */
  async remove(id: string): Promise<boolean> {
    return this.domain.table('items').delete(id)
  }

  /**
   * 清理（D-7）：已完成且超保留期的行。
   * 只在**打开域时**调用一次（避免每帧 I/O）。
   * @param now 当前时刻
   * @param retentionDays 保留天数（缺省 90）
   * @returns 清掉的条数
   */
  async prune(now: number, retentionDays?: number): Promise<number> {
    const table = this.domain.table('items')
    const ids = prunable(this.list(), now, retentionDays)
    let removed = 0
    for (const id of ids) {
      if (await table.delete(id)) removed += 1
    }

    return removed
  }

  /** 最近一条简报（面板读）。 */
  latestDigest(): AssistantDigest | undefined {
    const table = this.domain.table('digests')
    let latest: AssistantDigest | undefined
    for (const key of table.keys()) {
      const row = table.get(key)
      if (row === undefined) continue
      if (latest === undefined || row.createdAt > latest.createdAt) latest = row
    }

    return latest
  }

  /** 某天的简报。 */
  digestOf(date: string): AssistantDigest | undefined {
    return this.domain.table('digests').get(date)
  }

  /** 写一条简报（同一天覆盖，幂等）。 */
  async saveDigest(digest: AssistantDigest): Promise<AssistantDigest> {
    await this.domain.table('digests').put(digest.id, digest)
    return digest
  }

  /**
   * 清理超期简报。
   * @param now 当前时刻
   * @param retentionDays 保留天数（缺省 90）
   * @returns 清掉的条数
   */
  async pruneDigests(now: number, retentionDays = DIGEST_RETENTION_DAYS): Promise<number> {
    const table = this.domain.table('digests')
    const cutoff = now - retentionDays * DAY_MS
    let removed = 0
    for (const key of table.keys()) {
      const row = table.get(key)
      if (row === undefined || row.createdAt >= cutoff) continue
      if (await table.delete(key)) removed += 1
    }

    return removed
  }
}
