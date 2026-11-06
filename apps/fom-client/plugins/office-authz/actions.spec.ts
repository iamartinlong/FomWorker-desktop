import { describe, expect, it, vi } from 'vitest'
import { runConsoleAction } from './actions.ts'

describe('office-authz · 写操作三重防护决策 (runConsoleAction)', () => {
  it('角色不允许 ⇒ forbidden，且不执行', async () => {
    const execute = vi.fn(() => 'x')
    const result = await runConsoleAction({ role: 'member', action: 'bundle.install', approved: true }, execute)
    expect(result.status).toBe('forbidden')
    expect(execute).not.toHaveBeenCalled()
  })

  it('高危且未批准 ⇒ needs-approval，且不执行', async () => {
    const execute = vi.fn(() => 'x')
    const result = await runConsoleAction({ role: 'owner', action: 'bundle.install', approved: false }, execute)
    expect(result.status).toBe('needs-approval')
    expect(execute).not.toHaveBeenCalled()
  })

  it('高危且已批准 ⇒ done 并执行恰好一次', async () => {
    const execute = vi.fn(() => 42)
    const result = await runConsoleAction({ role: 'owner', action: 'bundle.install', approved: true }, execute)
    expect(result).toEqual({ status: 'done', value: 42 })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('非高危（member 建技能）无需批准即执行', async () => {
    const execute = vi.fn(() => 'ok')
    const result = await runConsoleAction({ role: 'member', action: 'skill.create', approved: false }, execute)
    expect(result).toEqual({ status: 'done', value: 'ok' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('授权先于审批：member 装插件即使 approved=true 仍 forbidden', async () => {
    const execute = vi.fn(() => 'x')
    const result = await runConsoleAction({ role: 'member', action: 'bundle.install', approved: true }, execute)
    expect(result.status).toBe('forbidden')
    expect(execute).not.toHaveBeenCalled()
  })
})
