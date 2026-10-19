/**
 * 「日终简报」纯逻辑验收：**空集不出版**、计数口径、正文分行、日期键与时点。
 * 所有时间都是显式样本（不依赖当前时钟），跨时区也稳定。
 */
import { describe, expect, it } from 'vitest'
import { buildDigest, dateKeyOf, nextDigestAt, startOfDay, MAX_DIGEST_LINES } from './digest.ts'
import { newItem, toggle, type AssistantItem } from './items.ts'

/** 用本地时间造时刻（避免测试依赖「今天几点」）。 */
function local(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function item(text: string, at: number, patch: Partial<AssistantItem> = {}): AssistantItem {
  return { ...newItem({ text }, at, `id-${text}`), ...patch }
}

const NOON = local(2026, 10, 19, 12)

describe('dateKeyOf / startOfDay / nextDigestAt', () => {
  it('日期键是本地 YYYY-MM-DD，补零', () => {
    expect(dateKeyOf(local(2026, 1, 5, 9))).toBe('2026-01-05')
    expect(dateKeyOf(local(2026, 12, 31, 23, 59))).toBe('2026-12-31')
  })

  it('当天 00:00（本地）', () => {
    expect(startOfDay(NOON)).toBe(local(2026, 10, 19, 0))
  })

  it('未到点 ⇒ 今天；已过点 ⇒ 明天', () => {
    expect(nextDigestAt(local(2026, 10, 19, 9), 18)).toBe(local(2026, 10, 19, 18))
    expect(nextDigestAt(local(2026, 10, 19, 19), 18)).toBe(local(2026, 10, 20, 18))
    // 正好到点也算「已过」（下次是明天），避免同一整点重复触发。
    expect(nextDigestAt(local(2026, 10, 19, 18), 18)).toBe(local(2026, 10, 20, 18))
  })

  it('时刻越界会被夹到 0–23', () => {
    expect(nextDigestAt(local(2026, 10, 19, 9), 99)).toBe(local(2026, 10, 19, 23))
    // 夹到 0 点 ⇒ 今天 0 点已过，顺延到明天 0 点。
    expect(nextDigestAt(local(2026, 10, 19, 9), -5)).toBe(local(2026, 10, 20, 0))
  })
})

describe('buildDigest（空集不出版）', () => {
  it('什么都没有 ⇒ undefined（不写空卡片）', () => {
    expect(buildDigest({ items: [], now: NOON })).toBeUndefined()
    expect(buildDigest({ items: [], todos: [], now: NOON })).toBeUndefined()
  })

  it('只有陈年已完成、且不在今天 ⇒ undefined', () => {
    const old = item('很久前完成', local(2026, 9, 1))
    const done = toggle(old, local(2026, 9, 1, 13))
    expect(buildDigest({ items: [done], now: NOON })).toBeUndefined()
  })
})

describe('buildDigest（计数与正文）', () => {
  it('今天完成 + 未完成，含逾期标记', () => {
    const finishedToday = toggle(item('交周报', local(2026, 10, 19, 9)), local(2026, 10, 19, 10))
    const overdue = item('报销', local(2026, 10, 15), { dueAt: local(2026, 10, 16) })
    const openNoDue = item('看书', local(2026, 10, 18))

    const digest = buildDigest({ items: [finishedToday, overdue, openNoDue], now: NOON })
    expect(digest).toBeDefined()
    expect(digest?.date).toBe('2026-10-19')
    expect(digest?.id).toBe('2026-10-19')
    expect(digest?.openCount).toBe(2)
    expect(digest?.doneToday).toBe(1)
    expect(digest?.overdueCount).toBe(1)
    expect(digest?.lines[0]).toBe('今天完成 1 条：交周报')
    expect(digest?.lines[1]).toContain('还有 2 条没做完，其中 1 条已逾期')
    expect(digest?.text).toContain('[逾期] 报销')
    expect(digest?.text).toContain('· 看书')
  })

  it('待办清空 ⇒ 明确说「已清空」', () => {
    const done = toggle(item('唯一一条', local(2026, 10, 19, 8)), local(2026, 10, 19, 9))
    const digest = buildDigest({ items: [done], now: NOON })
    expect(digest?.openCount).toBe(0)
    expect(digest?.lines).toContain('待办已清空')
  })

  it('未做完的多于上限 ⇒ 折叠成一行计数', () => {
    const many = Array.from({ length: MAX_DIGEST_LINES + 3 }, (_, index) =>
      item(`第 ${String(index)} 条`, local(2026, 10, 19)))
    const digest = buildDigest({ items: many, now: NOON })
    expect(digest?.openCount).toBe(MAX_DIGEST_LINES + 3)
    expect(digest?.lines).toContain(`…还有 3 条`)
    // 摘要一行 + 上限行 + 折叠一行
    expect(digest?.lines).toHaveLength(2 + MAX_DIGEST_LINES)
  })

  it('会话里还有未完成步骤 ⇒ 单独一行（只数 pending/in_progress）', () => {
    const digest = buildDigest({
      items: [item('干活', NOON)],
      now: NOON,
      todos: [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'completed' },
      ],
    })
    expect(digest?.lines).toContain('会话里还有 2 条未完成步骤')
  })

  it('只有会话待办、没有事项 ⇒ 也能出版（不算空集）', () => {
    const digest = buildDigest({ items: [], todos: [{ content: 'a', status: 'pending' }], now: NOON })
    expect(digest).toBeDefined()
    expect(digest?.openCount).toBe(0)
    expect(digest?.lines).toContain('会话里还有 1 条未完成步骤')
  })

  it('同一天重复生成 ⇒ 同样的正文（确定性，可对账）', () => {
    const items = [item('a', local(2026, 10, 19)), item('b', local(2026, 10, 18), { dueAt: local(2026, 10, 18) })]
    const first = buildDigest({ items, now: NOON })
    const second = buildDigest({ items, now: NOON })
    expect(second?.text).toBe(first?.text)
    expect(second?.id).toBe(first?.id)
  })
})
