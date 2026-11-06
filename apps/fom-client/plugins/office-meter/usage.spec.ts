import { describe, expect, it } from 'vitest'
import { foldSessionUsage, mergeByDay, type SessionLogRecord, type TokenUsage } from './usage.ts'

const message = (turn: number, step: number, time: number, usage: TokenUsage): SessionLogRecord => ({
  type: 'assistant/message', seq: 0, time, data: { turn, step, usage },
})
const attempt = (turn: number, step: number, time: number, usage: TokenUsage): SessionLogRecord => ({
  type: 'assistant/attempt', seq: 0, time, data: { turn, step, usage },
})

describe('office-meter · 折叠 (foldSessionUsage)', () => {
  it('assistant/message 计入', () => {
    const { summary } = foldSessionUsage('s', [message(1, 1, 0, { inputTokens: 10, outputTokens: 3 })])
    expect(summary.inputTokens).toBe(10)
    expect(summary.outputTokens).toBe(3)
  })

  it('同 (turn,step) 的 attempt 不重复计数（committed 在场）', () => {
    const { summary } = foldSessionUsage('s', [
      attempt(1, 1, 0, { inputTokens: 999, outputTokens: 999 }),
      message(1, 1, 0, { inputTokens: 10, outputTokens: 3 }),
    ])
    expect(summary.inputTokens).toBe(10)
    expect(summary.outputTokens).toBe(3)
  })

  it('无 committed 的 attempt 计入（不漏重试）', () => {
    const { summary } = foldSessionUsage('s', [attempt(2, 1, 0, { inputTokens: 5, outputTokens: 2 })])
    expect(summary.inputTokens).toBe(5)
    expect(summary.outputTokens).toBe(2)
  })

  it('计费输入 = input + cacheRead + cacheWrite', () => {
    const { summary } = foldSessionUsage('s', [
      message(1, 1, 0, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 20 }),
    ])
    expect(summary.billedInputTokens).toBe(170)
  })

  it('按 UTC 日拆分', () => {
    const day1 = Date.UTC(2026, 0, 1, 12, 0, 0)
    const day2 = Date.UTC(2026, 0, 2, 12, 0, 0)
    const { byDay } = foldSessionUsage('s', [
      message(1, 1, day1, { inputTokens: 1, outputTokens: 0 }),
      message(2, 1, day2, { inputTokens: 2, outputTokens: 0 }),
    ])
    expect(byDay['2026-01-01'].inputTokens).toBe(1)
    expect(byDay['2026-01-02'].inputTokens).toBe(2)
  })
})

describe('office-meter · 跨会话按天合并 (mergeByDay)', () => {
  it('同一天跨会话相加', () => {
    const t = Date.UTC(2026, 0, 1, 0, 0, 0)
    const a = foldSessionUsage('a', [message(1, 1, t, { inputTokens: 1, outputTokens: 1 })])
    const b = foldSessionUsage('b', [message(1, 1, t, { inputTokens: 2, outputTokens: 3 })])
    const out = mergeByDay([a, b])
    expect(out['2026-01-01'].inputTokens).toBe(3)
    expect(out['2026-01-01'].outputTokens).toBe(4)
  })
})
