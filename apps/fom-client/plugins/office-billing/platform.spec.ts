/**
 * 平台配额下发（K4 本地配额执行）的验收单测：DTO 归一 + 拉取语义（非 2xx 即抛、Bearer 只在有令牌时带）。
 */

import { describe, expect, it } from 'vitest'
import { fetchQuota, quotaFromDto, QUOTA_PATH } from './platform.ts'

const dto = { period: '2026-10', maxTokens: 1_000_000, maxCost: 5, maxCalls: 0, usedTokens: 12, usedCost: 0.5, usedCalls: 3 }

describe('quotaFromDto', () => {
  it('限额 0 ＝ 未设限 ⇒ 该维缺席（契约口径），已用照读', () => {
    const snapshot = quotaFromDto(dto, 123)
    expect(snapshot.period).toBe('2026-10')
    expect(snapshot.limits).toEqual({ maxTokens: 1_000_000, maxCost: 5 })
    expect(snapshot.limits.maxCalls).toBeUndefined()
    expect(snapshot.used).toEqual({ tokens: 12, cost: 0.5, calls: 3 })
    expect(snapshot.fetchedAt).toBe(123)
  })

  it('全 0 ⇒ 全未设限（BYO 默认形态：verdict 恒 within）', () => {
    const snapshot = quotaFromDto({ period: '2026-10', maxTokens: 0, maxCost: 0, maxCalls: 0 })
    expect(snapshot.limits).toEqual({})
    expect(snapshot.used).toEqual({ tokens: 0, cost: 0, calls: 0 })
  })

  it('缺字段按 0；period 缺省空串', () => {
    const snapshot = quotaFromDto({})
    expect(snapshot.period).toBe('')
    expect(snapshot.used).toEqual({ tokens: 0, cost: 0, calls: 0 })
  })

  it('不是对象 ⇒ 响亮抛（不静默当成「未设限」）', () => {
    expect(() => quotaFromDto(null)).toThrow(/不是对象/)
    expect(() => quotaFromDto('nope')).toThrow(/不是对象/)
    expect(() => quotaFromDto([1, 2])).toThrow(/不是对象/)
  })
})

describe('fetchQuota', () => {
  it('200 ⇒ 快照；有令牌 ⇒ 带 Bearer', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> }
      return new Response(JSON.stringify(dto), { status: 200 })
    }) as unknown as typeof fetch
    const snapshot = await fetchQuota({ platformUrl: 'http://platform.test/', token: () => 'tok', fetchImpl, now: () => 7 })
    expect(seen?.url).toBe(`http://platform.test${QUOTA_PATH}`)
    expect(seen?.headers.authorization).toBe('Bearer tok')
    expect(snapshot.period).toBe('2026-10')
    expect(snapshot.fetchedAt).toBe(7)
  })

  it('令牌为空 ⇒ 不带 Authorization（平台会 401）', async () => {
    let headers: Record<string, string> = {}
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify(dto), { status: 200 })
    }) as unknown as typeof fetch
    await fetchQuota({ platformUrl: 'http://platform.test', token: () => '', fetchImpl })
    expect(headers.authorization).toBeUndefined()
  })

  it('非 2xx ⇒ 抛（不拿旧值冒充新值）', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(fetchQuota({ platformUrl: 'http://platform.test', token: () => 'tok', fetchImpl })).rejects.toThrow(/HTTP 401/)
  })
})
