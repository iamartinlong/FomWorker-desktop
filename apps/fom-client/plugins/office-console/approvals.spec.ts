import { describe, expect, it } from 'vitest'
import { createApprovalStore, digestOf } from './approvals.ts'

describe('office-console · 审批存储', () => {
  it('request 创建 pending，且同载荷复用同一条', () => {
    let n = 0
    const store = createApprovalStore(() => `a${++n}`)
    const r1 = store.request('bundle.install', { spec: '@x/y' })
    const r2 = store.request('bundle.install', { spec: '@x/y' })
    expect(r1.id).toBe('a1')
    expect(r2.id).toBe('a1')
    expect(store.request('bundle.install', { spec: '@x/z' }).id).toBe('a2')
  })

  it('grant 只对 pending 生效', () => {
    const store = createApprovalStore(() => 'a1')
    expect(store.grant('nope')).toBeUndefined()
    expect(store.get('a1')).toBeUndefined()
    store.request('config.edit', {})
    expect(store.grant('a1')?.status).toBe('granted')
    expect(store.grant('a1')).toBeUndefined()
  })

  it('consume：granted 且摘要一致才放行，且一次性', () => {
    const store = createApprovalStore(() => 'a1')
    store.request('bundle.install', { spec: '@x/y' })
    expect(store.consume('a1', 'bundle.install', { spec: '@x/y' })).toBe(false) // 未批准
    store.grant('a1')
    expect(store.consume('a1', 'bundle.install', { spec: '@x/z' })).toBe(false) // 载荷不符
    expect(store.consume('a1', 'bundle.install', { spec: '@x/y' })).toBe(true) // 放行
    expect(store.get('a1')?.status).toBe('consumed')
    expect(store.consume('a1', 'bundle.install', { spec: '@x/y' })).toBe(false) // 已消费
  })

  it('reject', () => {
    const store = createApprovalStore(() => 'a1')
    store.request('config.edit', {})
    expect(store.reject('a1')?.status).toBe('rejected')
    expect(store.consume('a1', 'config.edit', {})).toBe(false)
  })

  it('digest 与键序无关', () => {
    expect(digestOf('bundle.install', { a: 1, b: 2 })).toBe(digestOf('bundle.install', { b: 2, a: 1 }))
    expect(digestOf('bundle.install', { a: 1 })).not.toBe(digestOf('bundle.install', { a: 2 }))
  })
})
