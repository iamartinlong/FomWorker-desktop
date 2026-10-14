import { describe, expect, it } from 'vitest'
import { evaluateQuota, OVERAGE_ACTIONS } from './quota.ts'

describe('office-billing · 限额裁决 (evaluateQuota)', () => {
  it('未超 ⇒ within、exceeded 空', () => {
    expect(evaluateQuota({ tokens: 10, cost: 1, calls: 1 }, { maxTokens: 50, maxCost: 5, maxCalls: 3 })).toEqual({
      within: true,
      exceeded: [],
      action: 'warn',
    })
  })

  it('逐维判超（含端点不超）', () => {
    const verdict = evaluateQuota({ tokens: 51, cost: 5, calls: 4 }, { maxTokens: 50, maxCost: 5, maxCalls: 3 })
    expect(verdict.within).toBe(false)
    expect(verdict.exceeded).toEqual(['tokens', 'calls'])
  })

  it('缺省维不判', () => {
    expect(evaluateQuota({ tokens: 9999, cost: 9999, calls: 9999 }, {}).within).toBe(true)
  })

  it('动作回显（配置传入）', () => {
    expect(evaluateQuota({ tokens: 1, cost: 0, calls: 0 }, { maxTokens: 0 }, 'reject').action).toBe('reject')
    expect(OVERAGE_ACTIONS).toEqual(['warn', 'reject', 'downgrade'])
  })
})
