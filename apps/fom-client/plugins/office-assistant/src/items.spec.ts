import { describe, expect, it } from 'vitest'
import {
  MAX_TEXT,
  copyFromSessionTodos,
  edit,
  isOverdue,
  newItem,
  normalizeText,
  prunable,
  sortItems,
  textError,
  toggle,
  type AssistantItem,
} from './items.ts'

const NOW = 1_790_000_000_000
const idOf = () => 'id-1'

function item(text: string, extra: Partial<AssistantItem> = {}): AssistantItem {
  return { ...newItem({ text }, NOW, `id-${text}`), ...extra }
}

describe('normalizeText / textError', () => {
  it('折叠空白；空与超长给错误文案', () => {
    expect(normalizeText('  写  周报  ')).toBe('写 周报')
    expect(textError('   ')).toBe('写点什么')
    expect(textError('x'.repeat(MAX_TEXT + 1))).toBe(`最多 ${MAX_TEXT} 字`)
    expect(textError('x'.repeat(MAX_TEXT))).toBeUndefined()
  })
})

describe('newItem', () => {
  it('落 createdAt/updatedAt/open，可选字段只在给了才出现', () => {
    const plain = newItem({ text: '  买咖啡  ' }, NOW, idOf())
    expect(plain).toEqual({
      id: 'id-1',
      text: '买咖啡',
      status: 'open',
      createdAt: NOW,
      updatedAt: NOW,
      source: 'panel',
    })
    expect('dueAt' in plain).toBe(false)

    const withDue = newItem({ text: '交周报', dueAt: NOW + 1_000, source: 'tool', sessionId: 's1' }, NOW, idOf())
    expect(withDue).toMatchObject({ dueAt: NOW + 1_000, source: 'tool', sessionId: 's1' })
  })

  it('空正文直接抛（不造脏行）', () => {
    expect(() => newItem({ text: '   ' }, NOW, idOf())).toThrow('写点什么')
  })
})

describe('toggle / edit', () => {
  it('勾选写 doneAt，取消把它去掉', () => {
    const done = toggle(item('a'), NOW + 5)
    expect(done).toMatchObject({ status: 'done', doneAt: NOW + 5, updatedAt: NOW + 5 })

    const back = toggle(done, NOW + 9)
    expect(back.status).toBe('open')
    expect('doneAt' in back).toBe(false)
    expect(back.updatedAt).toBe(NOW + 9)
  })

  it('改正文会 trim；空正文抛', () => {
    expect(edit(item('a'), '  改成这条  ', NOW + 1)).toMatchObject({ text: '改成这条', updatedAt: NOW + 1 })
    expect(() => edit(item('a'), '  ', NOW + 1)).toThrow('写点什么')
  })
})

describe('sortItems（D-6）', () => {
  it('未完成在前；有到期按到期升序；同档按更新时间降序', () => {
    const rows = [
      item('done-old', { status: 'done', doneAt: NOW - 100, updatedAt: NOW - 100 }),
      item('late', { dueAt: NOW + 9_000 }),
      item('early', { dueAt: NOW + 1_000 }),
      item('no-due-old', { updatedAt: NOW - 50 }),
      item('no-due-new', { updatedAt: NOW }),
    ]

    expect(sortItems(rows).map((row) => row.text)).toEqual([
      'early',
      'late',
      'no-due-new',
      'no-due-old',
      'done-old',
    ])
  })
})

describe('prunable（D-7：已完成超 90 天）', () => {
  it('只挑已完成且超期；未完成再久也不清', () => {
    const old = NOW - 91 * 24 * 60 * 60 * 1_000
    const rows = [
      item('old-done', { status: 'done', doneAt: old, updatedAt: old }),
      item('fresh-done', { status: 'done', doneAt: NOW - 1_000, updatedAt: NOW - 1_000 }),
      item('old-open', { updatedAt: old }),
    ]
    expect(prunable(rows, NOW)).toEqual(['id-old-done'])
  })
})

describe('isOverdue', () => {
  it('未完成且到期时刻已过 ⇒ true；已完成不算', () => {
    expect(isOverdue(item('a', { dueAt: NOW - 1 }), NOW)).toBe(true)
    expect(isOverdue(item('a', { dueAt: NOW + 1 }), NOW)).toBe(false)
    expect(isOverdue(item('a', { dueAt: NOW - 1, status: 'done' }), NOW)).toBe(false)
  })
})

describe('copyFromSessionTodos（D-9：只抄未完成、按正文去重）', () => {
  it('pending / in_progress 都抄；completed 跳过；已有同文的跳过', () => {
    const existing = [item('已经记过')]
    const created = copyFromSessionTodos(
      [
        { content: '写周报', status: 'pending' },
        { content: '已经记过', status: 'in_progress' },
        { content: '  写周报 ', status: 'in_progress' },
        { content: '早就做完的', status: 'completed' },
        { content: '   ', status: 'pending' },
      ],
      existing,
      NOW,
      () => `new-${Math.random()}`,
    )

    expect(created.map((row) => row.text)).toEqual(['写周报'])
    expect(created[0]?.status).toBe('open')
    expect(created[0]?.source).toBe('panel')
  })
})
