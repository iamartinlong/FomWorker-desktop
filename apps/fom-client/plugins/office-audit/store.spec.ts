import { describe, expect, it } from 'vitest'
import { createAuditStore } from './store.ts'
import type { AuditEntry, AuditKind } from './audit.ts'

function entry(tenant: string, sessionId: string, seq: number, time: number, type: string, kind: AuditKind = 'sandbox'): AuditEntry {
  const detail = kind === 'model' ? { kind: 'model' as const, provider: 'p', model: 'm' } : { kind: 'sandbox' as const, mode: 'm' }
  return { tenant, sessionId, seq, time, type, detail }
}

describe('office-audit · 索引存储 (createAuditStore)', () => {
  it('按 {tenant,sessionId,seq} 去重', () => {
    const store = createAuditStore()
    const a = entry('t1', 's1', 1, 10, 'sandbox/mode')
    expect(store.add([a])).toBe(1)
    expect(store.add([{ ...a, time: 999 }])).toBe(0)
    expect(store.size()).toBe(1)
  })

  it('查询：按 tenant / kind / type 过滤', () => {
    const store = createAuditStore()
    store.add([
      entry('t1', 's1', 1, 10, 'sandbox/mode'),
      entry('t1', 's1', 2, 11, 'model/selection', 'model'),
      entry('t2', 's2', 1, 12, 'sandbox/mode'),
    ])
    expect(store.query({ tenant: 't1' })).toHaveLength(2)
    expect(store.query({ type: 'sandbox/mode' })).toHaveLength(2)
    expect(store.query({ tenant: 't1', kind: 'sandbox' })).toHaveLength(1)
  })

  it('查询：时间窗（含端点）与 limit，结果按 (time, seq) 升序', () => {
    const store = createAuditStore()
    store.add([
      entry('t1', 's1', 9, 30, 'sandbox/mode'),
      entry('t1', 's1', 1, 10, 'sandbox/mode'),
      entry('t1', 's1', 2, 20, 'sandbox/mode'),
    ])
    expect(store.query({ since: 10, until: 20 }).map((e) => e.seq)).toEqual([1, 2])
    expect(store.query({ limit: 2 }).map((e) => e.seq)).toEqual([1, 2])
    expect(store.query({}).map((e) => e.time)).toEqual([10, 20, 30])
  })

  it('exportJsonl：按 (time,seq) 升序、每行一条', () => {
    const store = createAuditStore()
    store.add([entry('t1', 's1', 9, 30, 'b'), entry('t1', 's1', 1, 10, 'a')])
    const lines = store.exportJsonl().split('\n')
    expect(lines).toHaveLength(2)
    expect((JSON.parse(lines[0]) as AuditEntry).type).toBe('a')
  })

  it('空存储导出为空串', () => {
    expect(createAuditStore().exportJsonl()).toBe('')
  })
})
