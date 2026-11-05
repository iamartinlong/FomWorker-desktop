import { describe, expect, it } from 'vitest'
import { copyTodosIntoStore, type SessionTodoLike } from './copy-todos.ts'
import { newItem, type AssistantItem } from './items.ts'

const NOW = 1_790_000_000_000

/** 最小 store 替身（真 store 的行为已在 items-domain.spec 覆盖）。 */
function fakeStore(initial: AssistantItem[] = []) {
  const rows = [...initial]
  return {
    rows,
    list: () => [...rows],
    add: async (text: string, now: number, options: { source?: 'panel' | 'tool' | 'im'; sessionId?: string } = {}) => {
      const item = { ...newItem({ text, ...options }, now, `id-${rows.length}`), source: 'panel' as const }
      rows.push(item)
      return item
    },
  }
}

const todos = (list: Array<[string, string]>): SessionTodoLike[] => list.map(([content, status]) => ({ content, status }))

describe('copyTodosIntoStore', () => {
  it('抄未完成的、跳过已完成与空，带上 sessionId', async () => {
    const store = fakeStore()
    const created = await copyTodosIntoStore(
      store,
      todos([
        ['写周报', 'pending'],
        ['正在做的', 'in_progress'],
        ['早就做完', 'completed'],
        ['   ', 'pending'],
      ]),
      NOW,
      () => 'x',
      'session-1',
    )

    expect(created.map((row) => row.text)).toEqual(['写周报', '正在做的'])
    expect(store.rows.map((row) => row.text)).toEqual(['写周报', '正在做的'])
    expect(store.rows[0]?.sessionId).toBe('session-1')
  })

  it('已有同文未完成 ⇒ 不重复抄', async () => {
    const store = fakeStore([newItem({ text: '写周报' }, NOW, 'existing')])
    const created = await copyTodosIntoStore(store, todos([['写周报', 'pending']]), NOW, () => 'x')
    expect(created).toEqual([])
    expect(store.rows).toHaveLength(1)
  })

  it('会话没有待办 ⇒ 什么都不做', async () => {
    const store = fakeStore()
    expect(await copyTodosIntoStore(store, [], NOW, () => 'x')).toEqual([])
    expect(store.rows).toEqual([])
  })
})
