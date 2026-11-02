import { describe, expect, it } from 'vitest'
import { newItem, type AssistantItem } from '../items.ts'
import { doneLabel, formatDate, groupItems, itemMeta } from './items-view.ts'

const NOW = 1_790_000_000_000

function item(text: string, extra: Partial<AssistantItem> = {}): AssistantItem {
  return { ...newItem({ text }, NOW, `id-${text}`), ...extra }
}

describe('groupItems', () => {
  it('未完成/已完成分开，且保持传入顺序', () => {
    const rows = [item('a'), item('b', { status: 'done', doneAt: NOW }), item('c')]
    const groups = groupItems(rows)
    expect(groups.open.map((row) => row.text)).toEqual(['a', 'c'])
    expect(groups.done.map((row) => row.text)).toEqual(['b'])
  })
})

describe('itemMeta', () => {
  it('未完成无到期 ⇒ 空；有到期 ⇒ 「到期 · …」；过期 ⇒ 「已过期 · …」', () => {
    expect(itemMeta(item('a'), NOW)).toBe('')
    expect(itemMeta(item('a', { dueAt: NOW + 86_400_000 }), NOW)).toMatch(/^到期 · /)
    expect(itemMeta(item('a', { dueAt: NOW - 1_000 }), NOW)).toMatch(/^已过期 · /)
  })

  it('已完成 ⇒ 带完成时间', () => {
    expect(itemMeta(item('a', { status: 'done', doneAt: NOW }), NOW)).toMatch(/^已完成 · /)
    expect(itemMeta(item('a', { status: 'done' }), NOW)).toBe('已完成')
  })
})

describe('formatDate / doneLabel', () => {
  it('同年 MM-DD HH:mm；跨年补年份', () => {
    const sameYear = new Date(2026, 9, 19, 8, 5).getTime()
    expect(formatDate(sameYear, sameYear)).toBe('10-19 08:05')
    const otherYear = new Date(2025, 0, 2, 3, 4).getTime()
    expect(formatDate(otherYear, sameYear)).toBe('2025-01-02 03:04')
    expect(formatDate(Number.NaN, sameYear)).toBe('')
  })

  it('折叠标题带条数', () => {
    expect(doneLabel(0)).toBe('已完成（0）')
    expect(doneLabel(7)).toBe('已完成（7）')
  })
})
