/**
 * 读侧打分的验收单测（设计 §7 第 4 步：DM6 公式 `类型权重 × exp(-Δ天/τ) × 命中密度`）。
 *
 * 这个分数只服务蒸馏淘汰与召回排序两处（§3.4）；常驻索引的裁剪**故意不用它**（那是 ME5 的
 * 分工，见 inject.spec）。这里断言的是公式本身的单调性与边界。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_TAU_DAYS, TYPE_WEIGHTS, entryTypeFromLine, hitDensity, memoryScore } from './recall.ts'

describe('entryTypeFromLine', () => {
  it('认出四种条目类型，非条目行返回 undefined', () => {
    expect(entryTypeFromLine('- [标题](feedback/a.md) — 钩子')).toBe('feedback')
    expect(entryTypeFromLine('- [标题](nonsense/a.md) — 钩子')).toBeUndefined()
    expect(entryTypeFromLine('# 记忆索引')).toBeUndefined()
    expect(entryTypeFromLine('随便一行')).toBeUndefined()
  })
})

describe('hitDensity', () => {
  it('无查询词记 1（常驻这一路本就无查询）', () => {
    expect(hitDensity([], '任何文本')).toBe(1)
  })
  it('按命中的查询词占比，大小写无关', () => {
    expect(hitDensity(['Q4', '法务'], 'Q4 报告由法务口径驱动')).toBe(1)
    expect(hitDensity(['q4', '排版'], 'Q4 报告由法务口径驱动')).toBe(0.5)
  })
  it('一个词都没命中就是 0 —— 这就是「索引里没有相关条目」在分数上的形态（支撑 ME11：别硬凑引用）', () => {
    expect(hitDensity(['不存在的词'], 'Q4 报告由法务口径驱动')).toBe(0)
    expect(memoryScore({ type: 'project', ageDays: 0, queryTerms: ['不存在的词'], indexText: 'Q4 报告' })).toBe(0)
  })
})

describe('memoryScore：类型权重 × exp(-Δ天/τ) × 命中密度', () => {
  it('同类型越近越大，一个 τ 处正好折到 1/e', () => {
    const fresh = memoryScore({ type: 'project', ageDays: 0 })
    const oneTau = memoryScore({ type: 'project', ageDays: DEFAULT_TAU_DAYS })
    expect(oneTau).toBeCloseTo(fresh / Math.E, 6)
  })
  it('类型权重决定量级：user 高于 reference', () => {
    expect(memoryScore({ type: 'user', ageDays: 10 })).toBeGreaterThan(memoryScore({ type: 'reference', ageDays: 10 }))
    expect(TYPE_WEIGHTS.user).toBeGreaterThan(TYPE_WEIGHTS.reference)
  })
  it('未来的 createdAt（负 age）按 0 处理，不因为写歪而加权', () => {
    expect(memoryScore({ type: 'project', ageDays: -999 })).toBeCloseTo(memoryScore({ type: 'project', ageDays: 0 }))
  })
  it('τ 可注入：更小的 τ 让老条目掉得更快', () => {
    const slow = memoryScore({ type: 'project', ageDays: 30 }, { tauDays: 30 })
    const fast = memoryScore({ type: 'project', ageDays: 30 }, { tauDays: 10 })
    expect(fast).toBeLessThan(slow)
  })
})
