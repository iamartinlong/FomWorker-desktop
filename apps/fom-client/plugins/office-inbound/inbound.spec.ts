import { describe, expect, it, vi } from 'vitest'
import { handleInbound, type CreateSessionPort } from './inbound.ts'
import type { RouterTables } from '../office-router/directory.ts'

const tables: RouterTables = {
  bindings: { ou_a: { tenantId: 't1', role: 'member' } },
  tenants: { t1: { tenantId: 't1', homeDir: 'C:/t1/.dsh', workspaceRoot: 'C:/t1/ws' } },
}

describe('office-inbound · 入站决策核', () => {
  it('已绑定：按计划建会话，传 cwd/preset/正文', async () => {
    const create = vi.fn(async () => ({ sessionId: 's1' }))
    const port: CreateSessionPort = { create }
    const result = await handleInbound({ openId: 'ou_a', text: '帮我写周报' }, { tables, create: port })
    expect(result).toEqual({ status: 'created', sessionId: 's1' })
    expect(create).toHaveBeenCalledWith({ cwd: 'C:/t1/ws', agentPreset: 'office', identityNotice: expect.stringContaining('t1'), text: '帮我写周报' })
  })

  it('未绑定：丢弃（unauthorized），不建会话', async () => {
    const create = vi.fn(async () => ({ sessionId: 'x' }))
    const result = await handleInbound({ openId: 'ou_unknown', text: 'hi' }, { tables, create: { create } })
    expect(result).toEqual({ status: 'unauthorized' })
    expect(create).not.toHaveBeenCalled()
  })

  it('建会话抛错：failed（不冒泡）', async () => {
    const port: CreateSessionPort = { create: async () => { throw new Error('boom') } }
    const result = await handleInbound({ openId: 'ou_a', text: 'x' }, { tables, create: port })
    expect(result).toEqual({ status: 'failed', message: 'boom' })
  })
})
