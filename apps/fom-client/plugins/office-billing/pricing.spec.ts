import { describe, expect, it } from 'vitest'
import { costOf, resolvePrice, type ModelPrice, type PriceTable } from './pricing.ts'

const m1: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 }
const fallback: ModelPrice = { inputPerMTok: 1, outputPerMTok: 1 }
const table: PriceTable = { currency: 'USD', models: { m1 }, fallback }

describe('office-billing · 折算 (costOf)', () => {
  it('输入/输出/缓存分桶折算（每百万 token）', () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, m1)).toBe(18)
    expect(costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, m1)).toBeCloseTo(0.3)
    expect(costOf({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }, m1)).toBeCloseTo(3.75)
  })

  it('缓存单价缺省 = 输入单价', () => {
    expect(costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, fallback)).toBeCloseTo(1)
  })

  it('非有限数按 0', () => {
    expect(costOf({ inputTokens: Number.NaN, outputTokens: 1_000_000 }, m1)).toBe(15)
  })
})

describe('office-billing · 价格解析 (resolvePrice)', () => {
  it('表内命中 / 兜底 / 未定价', () => {
    expect(resolvePrice(table, 'm1')).toBe(m1)
    expect(resolvePrice(table, 'unknown')).toBe(fallback)
    expect(resolvePrice({ currency: 'USD', models: {} }, 'unknown')).toBeUndefined()
  })
})
