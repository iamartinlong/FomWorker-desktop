import { describe, expect, it } from 'vitest'
import { toAuditReports, toUsageReports } from './messages.ts'

const CTX = { tenantId: 't1', userId: 'u1', source: 'platform' as const }

describe('toUsageReports', () => {
  it('计 assistant/message 的 usage（per-call）', () => {
    const out = toUsageReports('s1', [{ type: 'assistant/message', time: 0, data: { usage: { inputTokens: 10, outputTokens: 5 }, turn: 1, step: 2 } }], CTX)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'usage.report', sessionId: 's1', turn: 1, step: 2, inputTokens: 10, outputTokens: 5, source: 'platform' })
  })

  it('attempt 仅在无已提交 message 时补计', () => {
    const records = [
      { type: 'assistant/attempt', time: 0, data: { usage: { inputTokens: 3 }, turn: 1, step: 1, attempt: 0 } },
      { type: 'assistant/message', time: 0, data: { usage: { inputTokens: 10 }, turn: 1, step: 1 } },
      { type: 'assistant/attempt', time: 0, data: { usage: { inputTokens: 7 }, turn: 2, step: 1 } },
    ]
    const out = toUsageReports('s1', records, CTX)
    expect(out.map((r) => r.turn)).toEqual([1, 2])
  })

  it('缺 usage 的记录不计', () => {
    expect(toUsageReports('s1', [{ type: 'tool/call', data: {} }], CTX)).toHaveLength(0)
  })
})

describe('toAuditReports', () => {
  it('映射审计条目', () => {
    const out = toAuditReports([{ tenant: 't1', sessionId: 's1', seq: 5, time: 100, type: 'tool/call', detail: { kind: 'tool', phase: 'call' } }], CTX)
    expect(out[0]).toMatchObject({ type: 'audit.report', sessionId: 's1', seq: 5, eventType: 'tool/call' })
  })
})
