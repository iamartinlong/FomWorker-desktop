import { describe, expect, it } from 'vitest'
import { quotaView } from './quota-view.ts'

describe('quotaView', () => {
  it('未同步 / 拿不到 ⇒ available:false，不编数字', () => {
    for (const payload of [null, {}, { ok: true, snapshot: null, verdict: null }, { ok: false, message: 'HTTP 401' }]) {
      const view = quotaView(payload)
      expect(view.available).toBe(false)
      expect(view.rows).toEqual([])
      expect(view.verdict).toBe('unknown')
      expect(view.note).toContain('还没有配额数据')
    }
  })

  it('未登录 ⇒ 空态直接说「未登录」，别让用户以为是「没数据」', () => {
    const guest = quotaView({ ok: false, message: 'HTTP 401' }, false)
    expect(guest.available).toBe(false)
    expect(guest.note).toContain('未登录')
    // 已登录但还没同步过 ⇒ 中性文案，不谎称未登录。
    const signedButEmpty = quotaView({ ok: false, message: 'HTTP 401' }, true)
    expect(signedButEmpty.note).not.toContain('未登录')
    // 未探测（undefined）⇒ 与旧行为一致，中性文案。
    expect(quotaView({ ok: false }).note).toBe(signedButEmpty.note)
  })

  it('已登录且有快照 ⇒ 登录态不影响正常展示', () => {
    const view = quotaView({
      ok: true,
      snapshot: { period: '2026-10', limits: { maxTokens: 100 }, used: { tokens: 1, cost: 0, calls: 0 } },
      verdict: { within: true, exceeded: [] },
    }, true)
    expect(view.available).toBe(true)
    expect(view.rows).toHaveLength(3)
  })

  it('同步过 ⇒ 三行 + 未设限维留空 + 正常态', () => {
    const view = quotaView({
      ok: true,
      snapshot: { period: '2026-10', limits: { maxTokens: 1_000_000 }, used: { tokens: 12, cost: 0.5, calls: 3 }, fetchedAt: 1 },
      verdict: { within: true, exceeded: [], action: 'warn' },
    })
    expect(view.available).toBe(true)
    expect(view.period).toBe('2026-10')
    expect(view.verdict).toBe('within')
    expect(view.rows.map(row => row.key)).toEqual(['tokens', 'cost', 'calls'])
    expect(view.rows[0]).toMatchObject({ used: 12, limit: 1_000_000, exceeded: false })
    expect(view.rows[1]!.limit).toBeUndefined()
    expect(view.rows[2]!.limit).toBeUndefined()
  })

  it('超限 ⇒ verdict:exceeded + 标出超的维 + 说明里点明本地不阻断', () => {
    const view = quotaView({
      ok: true,
      snapshot: { period: '2026-10', limits: { maxTokens: 100 }, used: { tokens: 120, cost: 0, calls: 0 } },
      verdict: { within: false, exceeded: ['tokens'], action: 'reject' },
    })
    expect(view.verdict).toBe('exceeded')
    expect(view.rows.find(row => row.key === 'tokens')!.exceeded).toBe(true)
    expect(view.rows.find(row => row.key === 'cost')!.exceeded).toBe(false)
    expect(view.note).toContain('本地不阻断')
  })

  it('有快照但平台没给 verdict ⇒ unknown（不猜「正常」）', () => {
    const view = quotaView({ ok: true, snapshot: { period: '2026-10', limits: {}, used: { tokens: 1, cost: 0, calls: 0 } }, verdict: null })
    expect(view.available).toBe(true)
    expect(view.verdict).toBe('unknown')
  })
})
