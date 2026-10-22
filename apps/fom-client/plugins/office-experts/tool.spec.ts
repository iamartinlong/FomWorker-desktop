import { describe, expect, it, vi } from 'vitest'
import { createExpertTools, type ExpertCreatePort } from './tool.ts'

describe('office-experts · expert_create 工具', () => {
  it('参数合成 delta 交给 port（逗号分隔拆数组）', async () => {
    const port: ExpertCreatePort = { create: vi.fn(async (delta) => ({ id: delta.id, path: `/x/${delta.id}.json` })) }
    const { create } = createExpertTools(port)
    const out = await create.execute(
      { id: 'e1', name: 'E1', personaPrefix: '你是资深法务', tools: 'plan-mode, tool-subagent', skills: 'a, b' },
      undefined as never,
    )
    expect(port.create).toHaveBeenCalledWith({
      id: 'e1',
      name: 'E1',
      description: '',
      persona: { prefix: '你是资深法务' },
      tools: { enable: ['plan-mode', 'tool-subagent'] },
      skills: ['a', 'b'],
    })
    expect(out).toEqual({ id: 'e1', path: '/x/e1.json' })
  })

  it('空 tools / skills 不带（不产出空数组）', async () => {
    const port: ExpertCreatePort = { create: vi.fn(async (delta) => ({ id: delta.id, path: 'p' })) }
    const { create } = createExpertTools(port)
    await create.execute({ id: 'e2', name: 'E2', tools: '', skills: '' }, undefined as never)
    expect(port.create).toHaveBeenCalledWith({ id: 'e2', name: 'E2', description: '', persona: {}, tools: {} })
  })
})
