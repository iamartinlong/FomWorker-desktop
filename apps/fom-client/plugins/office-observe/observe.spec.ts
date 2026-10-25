import { describe, expect, it } from 'vitest'
import { approvalLatency, buildMetrics, buildSnapshot, failureStats } from './observe.ts'
import type { AuditEntry, AuditDetail } from '../office-audit/audit.ts'
import type { SessionUsage, UsageSummary } from '../office-meter/usage.ts'

function e(sessionId: string, time: number, detail: AuditDetail): AuditEntry {
  return { tenant: 't1', sessionId, seq: time, time, type: `x`, detail }
}

describe('office-observe · 审批等待时长', () => {
  it('配对 asked→decided，未决计 pending', () => {
    const out = approvalLatency([
      e('s1', 100, { kind: 'approval', phase: 'asked', id: 'a', toolName: 'bash' }),
      e('s1', 150, { kind: 'approval', phase: 'decided', id: 'a', outcome: 'allowed-once' }),
      e('s1', 200, { kind: 'approval', phase: 'asked', id: 'b', toolName: 'write' }),
    ])
    expect(out).toEqual({ decided: 1, pending: 1, avgMs: 50, maxMs: 50 })
  })

  it('跨会话同 id 不配对', () => {
    const out = approvalLatency([
      e('s1', 10, { kind: 'approval', phase: 'asked', id: 'x', toolName: 'bash' }),
      e('s2', 20, { kind: 'approval', phase: 'decided', id: 'x', outcome: 'rejected' }),
    ])
    expect(out).toEqual({ decided: 0, pending: 1, avgMs: 0, maxMs: 0 })
  })

  it('无审批 → 全零', () => {
    expect(approvalLatency([])).toEqual({ decided: 0, pending: 0, avgMs: 0, maxMs: 0 })
  })
})

describe('office-observe · 失败率', () => {
  it('工具调用/结果/失败 + 错误码 + 回合原因', () => {
    const out = failureStats([
      e('s1', 1, { kind: 'tool', phase: 'call', name: 'read', callId: 'c1', paths: [] }),
      e('s1', 2, { kind: 'tool', phase: 'result', turn: 1, step: 1, ok: true }),
      e('s1', 3, { kind: 'tool', phase: 'result', turn: 1, step: 1, ok: false, errorCode: 'E1' }),
      e('s1', 4, { kind: 'tool', phase: 'result', turn: 1, step: 1, ok: false }),
      e('s1', 5, { kind: 'turn', turn: 1, reason: 'completed' }),
    ])
    expect(out.toolCalls).toBe(1)
    expect(out.toolResults).toBe(3)
    expect(out.toolFailures).toBe(2)
    expect(out.failureRate).toBeCloseTo(2 / 3)
    expect(out.byErrorCode).toEqual({ E1: 1, unknown: 1 })
    expect(out.turnEndByReason).toEqual({ completed: 1 })
  })

  it('无工具结果 → 失败率 0', () => {
    expect(failureStats([]).failureRate).toBe(0)
  })
})

describe('office-observe · 快照/指标合成', () => {
  const summary: UsageSummary = {
    inputTokens: 5,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    billedInputTokens: 5,
  }

  it('buildSnapshot 合并 token 按天 + 指标', () => {
    const sessions: SessionUsage[] = [{ sessionId: 's', summary, byDay: { '2026-01-02': summary } }]
    const snap = buildSnapshot('t1', sessions, [e('s', 5, { kind: 'turn', turn: 1, reason: 'error' })])
    expect(snap.tenant).toBe('t1')
    expect(snap.tokensByDay['2026-01-02'].inputTokens).toBe(5)
    expect(snap.metrics.failures.turnEndByReason).toEqual({ error: 1 })
  })

  it('buildMetrics 组合审批与失败', () => {
    const metrics = buildMetrics([e('s', 1, { kind: 'approval', phase: 'asked', id: 'a', toolName: 'bash' })])
    expect(metrics.approval.pending).toBe(1)
    expect(metrics.failures.toolResults).toBe(0)
  })
})
