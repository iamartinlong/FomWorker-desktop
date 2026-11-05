/**
 * 编排层验收：取数失败**不阻塞**简报、空集不落盘、同一天覆盖（幂等）。
 */
import { describe, expect, it, vi } from 'vitest'
import { runDigest } from './digest-run.ts'
import { newItem, type AssistantItem } from './items.ts'
import type { AssistantDigest } from './digest.ts'

const NOW = new Date(2026, 9, 19, 12, 0, 0, 0).getTime()

function item(text: string, patch: Partial<AssistantItem> = {}): AssistantItem {
  return { ...newItem({ text }, NOW, `id-${text}`), ...patch }
}

function recorder(): { saved: AssistantDigest[]; save(digest: AssistantDigest): Promise<AssistantDigest> } {
  const saved: AssistantDigest[] = []
  return {
    saved,
    save: async (digest) => {
      saved.push(digest)
      return digest
    },
  }
}

describe('runDigest', () => {
  it('有事项 ⇒ 落盘一份，返回同一份', async () => {
    const sink = recorder()
    const result = await runDigest({ listItems: () => [item('干活')], save: sink.save, now: () => NOW })
    expect(result?.date).toBe('2026-10-19')
    expect(sink.saved).toHaveLength(1)
    expect(sink.saved[0].id).toBe(result?.id)
  })

  it('空集 ⇒ 不落盘、返回 undefined', async () => {
    const sink = recorder()
    expect(await runDigest({ listItems: () => [], save: sink.save, now: () => NOW })).toBeUndefined()
    expect(sink.saved).toEqual([])
  })

  it('读会话失败 ⇒ 忽略那一行，仍然出版', async () => {
    const sink = recorder()
    const readTodos = vi.fn(async () => {
      throw new Error('会话读不了')
    })
    const result = await runDigest({
      listItems: () => [item('干活')],
      readTodos,
      save: sink.save,
      now: () => NOW,
    })
    expect(readTodos).toHaveBeenCalledOnce()
    expect(result).toBeDefined()
    expect(result?.lines.some((line) => line.includes('会话里'))).toBe(false)
  })

  it('会话待办接进来 ⇒ 多一行', async () => {
    const sink = recorder()
    const result = await runDigest({
      listItems: () => [item('干活')],
      readTodos: async () => [{ content: 'x', status: 'pending' }],
      save: sink.save,
      now: () => NOW,
    })
    expect(result?.lines).toContain('会话里还有 1 条未完成步骤')
  })

  it('同一天跑两次 ⇒ 同一个 id（覆盖，不堆叠）', async () => {
    const sink = recorder()
    const deps = { listItems: () => [item('干活')], save: sink.save, now: () => NOW }
    await runDigest(deps)
    await runDigest(deps)
    expect(sink.saved.map((digest) => digest.id)).toEqual(['2026-10-19', '2026-10-19'])
  })
})
