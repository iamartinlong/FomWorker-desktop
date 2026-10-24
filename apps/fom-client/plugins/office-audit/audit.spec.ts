import { describe, expect, it } from 'vitest'
import { auditKey, collectAudit, extractPaths, foldAudit, toAuditEntry, type AuditEntry } from './audit.ts'
import type { SessionLogRecord } from '../office-meter/usage.ts'
import type { SessionLogSet } from '../office-meter/reader.ts'

function entry(type: string, seq: number, time: number, data: Record<string, unknown>): SessionLogRecord {
  return { type, seq, time, data }
}

describe('office-audit · 路径抽取 (extractPaths)', () => {
  it('认 file_path / path', () => {
    expect(extractPaths('{"file_path":"a.txt","path":"b/c"}')).toEqual(['a.txt', 'b/c'])
  })

  it('认数组字段（paths/files）', () => {
    expect(extractPaths('{"paths":["x","y"],"dir":"z"}')).toEqual(['x', 'y', 'z'])
  })

  it('空串与非字符串忽略', () => {
    expect(extractPaths('{"file_path":"","path":42}')).toEqual([])
  })

  it('坏 JSON / 非对象 → 空', () => {
    expect(extractPaths('{ not json')).toEqual([])
    expect(extractPaths('[1,2]')).toEqual([])
    expect(extractPaths(undefined)).toEqual([])
  })
})

describe('office-audit · 事件映射 (toAuditEntry)', () => {
  it('tool/call → 含 name/callId/paths', () => {
    const out = toAuditEntry(entry('tool/call', 3, 100, { name: 'read', callId: 'c1', arguments: '{"file_path":"a.txt"}' }), 't1', 's1')
    expect(out).toMatchObject({ tenant: 't1', sessionId: 's1', seq: 3, time: 100, type: 'tool/call' })
    expect(out?.detail).toEqual({ kind: 'tool', phase: 'call', name: 'read', callId: 'c1', paths: ['a.txt'] })
  })

  it('tool/call 缺 name → 不可审计', () => {
    expect(toAuditEntry(entry('tool/call', 3, 100, { callId: 'c1' }), 't1', 's1')).toBeUndefined()
  })

  it('tool/result 成功与失败', () => {
    const ok = toAuditEntry(entry('tool/result', 4, 101, { turn: 1, step: 1 }), 't1', 's1')
    expect(ok?.detail).toEqual({ kind: 'tool', phase: 'result', turn: 1, step: 1, ok: true })
    const bad = toAuditEntry(entry('tool/result', 5, 102, { turn: 1, step: 1, error: { name: 'E', code: 'E_BOOM' } }), 't1', 's1')
    expect(bad?.detail).toEqual({ kind: 'tool', phase: 'result', turn: 1, step: 1, ok: false, errorCode: 'E_BOOM' })
  })

  it('approval/asked 与 approval/decided', () => {
    const asked = toAuditEntry(entry('approval/asked', 6, 103, { id: 'ap1', toolName: 'bash', reason: 'rm' }), 't1', 's1')
    expect(asked?.detail).toEqual({ kind: 'approval', phase: 'asked', id: 'ap1', toolName: 'bash', reason: 'rm' })
    const decided = toAuditEntry(entry('approval/decided', 7, 104, { id: 'ap1', outcome: 'rejected' }), 't1', 's1')
    expect(decided?.detail).toEqual({ kind: 'approval', phase: 'decided', id: 'ap1', outcome: 'rejected' })
  })

  it('hook/invoked 与 hook/result', () => {
    const invoked = toAuditEntry(entry('hook/invoked', 8, 105, { point: 'PreToolUse', handlerId: 'h1' }), 't1', 's1')
    expect(invoked?.detail).toEqual({ kind: 'hook', phase: 'invoked', point: 'PreToolUse', handlerId: 'h1' })
    const result = toAuditEntry(entry('hook/result', 9, 106, { point: 'PreToolUse', handlerId: 'h1', decision: 'pass', durationMs: 3 }), 't1', 's1')
    expect(result?.detail).toEqual({ kind: 'hook', phase: 'result', point: 'PreToolUse', handlerId: 'h1', decision: 'pass', durationMs: 3 })
  })

  it('permission/preset · sandbox/mode · model/selection', () => {
    expect(toAuditEntry(entry('permission/preset', 10, 107, { preset: 'default' }), 't1', 's1')?.detail).toEqual({ kind: 'permission', preset: 'default' })
    expect(toAuditEntry(entry('sandbox/mode', 11, 108, { mode: 'workspace-write' }), 't1', 's1')?.detail).toEqual({ kind: 'sandbox', mode: 'workspace-write' })
    expect(toAuditEntry(entry('model/selection', 12, 109, { provider: 'p', model: 'm' }), 't1', 's1')?.detail).toEqual({ kind: 'model', provider: 'p', model: 'm' })
  })

  it('turn/end → 取 reason.kind', () => {
    const out = toAuditEntry(entry('turn/end', 13, 110, { turn: 2, reason: { kind: 'completed' } }), 't1', 's1')
    expect(out?.detail).toEqual({ kind: 'turn', turn: 2, reason: 'completed' })
    const aborted = toAuditEntry(entry('turn/end', 14, 111, { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }), 't1', 's1')
    expect(aborted?.detail).toEqual({ kind: 'turn', turn: 2, reason: 'aborted' })
  })

  it('非审计事件 / 缺 type → undefined', () => {
    expect(toAuditEntry(entry('assistant/message', 1, 1, {}), 't1', 's1')).toBeUndefined()
    expect(toAuditEntry({ seq: 1, time: 1 }, 't1', 's1')).toBeUndefined()
  })
})

describe('office-audit · 折叠 (foldAudit / collectAudit / auditKey)', () => {
  it('foldAudit 保序并带上 sessionId', () => {
    const records = [
      entry('assistant/message', 1, 1, {}),
      entry('tool/call', 2, 2, { name: 'read', callId: 'c', arguments: '{}' }),
      entry('turn/end', 3, 3, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const out = foldAudit({ sessionId: 'sA', records }, 't1')
    expect(out.map((e) => e.type)).toEqual(['tool/call', 'turn/end'])
    expect(out.every((e) => e.sessionId === 'sA' && e.tenant === 't1')).toBe(true)
  })

  it('collectAudit 跨会话', () => {
    const logSet: SessionLogSet = {
      files: 2,
      badLines: 0,
      sessions: [
        { sessionId: 'sA', records: [entry('tool/call', 1, 1, { name: 'read', callId: 'c' })] },
        { sessionId: 'sB', records: [entry('sandbox/mode', 1, 2, { mode: 'read-only' })] },
      ],
    }
    const out = collectAudit(logSet, 't1')
    expect(out.map((e) => e.sessionId)).toEqual(['sA', 'sB'])
  })

  it('auditKey 仅由 tenant/sessionId/seq 决定', () => {
    const a: AuditEntry = { tenant: 't', sessionId: 's', seq: 5, time: 1, type: 'x', detail: { kind: 'model', provider: 'p', model: 'm' } }
    const b: AuditEntry = { ...a, time: 999, type: 'y' }
    expect(auditKey(a)).toBe(auditKey(b))
  })
})
