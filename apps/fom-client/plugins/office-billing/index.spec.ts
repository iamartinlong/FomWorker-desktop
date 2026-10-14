import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, createBillingService, name, type OfficeBilling, type OfficeBillingConfig } from './index.ts'
import type { PriceTable } from './pricing.ts'

function fakeCtx(): { ctx: Context; provided: Map<string, unknown>; disposer: () => (() => void) | void | undefined } {
  const provided = new Map<string, unknown>()
  let disposer: (() => void) | void | undefined
  const ctx = {
    reflect: { provide: (key: string, value: unknown) => { provided.set(key, value); return () => { provided.delete(key) } } },
    effect: (setup: () => (() => void) | void) => { disposer = setup(); return disposer },
  }
  return { ctx: ctx as unknown as Context, provided, disposer: () => disposer }
}

const config: OfficeBillingConfig = {
  currency: 'USD',
  prices: { m1: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 } },
  overageAction: 'reject',
}

describe('office-billing 插件壳', () => {
  it('name 正确', () => expect(name).toBe('office-billing'))

  it('apply 提供 officeBilling 服务，卸载后撤掉', () => {
    const fake = fakeCtx()
    apply(fake.ctx, config)
    const svc = fake.provided.get('officeBilling') as OfficeBilling
    expect(svc).toBeDefined()
    expect(svc.cost('m1', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(18)
    fake.disposer()?.()
    expect(fake.provided.has('officeBilling')).toBe(false)
  })

  it('apply 非法 overageAction ⇒ 响亮抛', () => {
    expect(() => apply(fakeCtx().ctx, { ...config, overageAction: 'block' })).toThrow(/overageAction/)
  })

  it('createBillingService：cost / total（未定价不静默按 0）/ quota', () => {
    const table: PriceTable = { currency: 'USD', models: config.prices }
    const svc = createBillingService(table, 'warn')
    expect(svc.cost('m1', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(3)
    expect(svc.cost('nope', { inputTokens: 1, outputTokens: 1 })).toBeUndefined()
    const breakdown = svc.total([
      { model: 'm1', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      { model: 'nope', usage: { inputTokens: 1, outputTokens: 0 } },
    ])
    expect(breakdown.amount).toBe(18)
    expect(breakdown.unpriced).toEqual(['nope'])
    expect(svc.quota({ tokens: 1, cost: 0, calls: 0 }, { maxTokens: 0 })).toMatchObject({ within: false, action: 'warn' })
  })
})
