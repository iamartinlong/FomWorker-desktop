import { describe, expect, it } from 'vitest'
import { planSession, toSessionCreation } from './wiring.ts'
import { resolveContext, type RouterTables } from './directory.ts'

const tables: RouterTables = {
  bindings: { ou_a: { tenantId: 't1', role: 'member' } },
  tenants: { t1: { tenantId: 't1', homeDir: 'C:/t1/.dsh', workspaceRoot: 'C:/t1/ws' } },
}

describe('office-router · 创建桥 (R0 输出)', () => {
  it('会话章 → 创建计划（cwd/预设/提示）', () => {
    const stamp = resolveContext('ou_a', tables)
    expect(stamp).toBeDefined()
    const plan = toSessionCreation(stamp!)
    expect(plan.cwd).toBe('C:/t1/ws')
    expect(plan.agentPreset).toBe('office') // member → office
    expect(plan.identityNotice).toContain('t1')
    expect(plan.identityNotice).toContain('member')
  })

  it('planSession：已绑定给计划；未绑定 undefined', () => {
    expect(planSession('ou_a', tables)?.agentPreset).toBe('office')
    expect(planSession('ou_unknown', tables)).toBeUndefined()
  })
})
