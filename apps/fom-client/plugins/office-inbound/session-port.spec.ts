import { describe, expect, it, vi } from 'vitest'
import { createKernelSessionPort, type SessionCreatorLike } from './session-port.ts'

describe('office-inbound · 内核建会话口适配器', () => {
  it('把 CreateSessionRequest 映射到内核 create 参数', async () => {
    const create = vi.fn(async () => ({ sessionId: 's1' }))
    const creator: SessionCreatorLike = { create }
    const port = createKernelSessionPort(creator)
    const result = await port.create({ cwd: 'C:/t1/ws', agentPreset: 'office', identityNotice: '你是 t1 的 member', text: '写周报' })
    expect(result).toEqual({ sessionId: 's1' })
    expect(create).toHaveBeenCalledWith({ cwd: 'C:/t1/ws', agentPreset: 'office', identityNotice: '你是 t1 的 member', prompt: '写周报' })
  })
})
