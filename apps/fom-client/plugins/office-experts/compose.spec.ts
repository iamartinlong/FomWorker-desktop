import { describe, expect, it } from 'vitest'
import { ADVANCED_ROW_IDS, OFFICE_BASE } from './base.ts'
import { composeExpert, composeExpertRows } from './compose.ts'
import type { ExpertDelta } from './delta.ts'

/** 造一个最小 delta。 */
function delta(over: Partial<ExpertDelta> = {}): ExpertDelta {
  return { id: 'x', name: 'X', description: 'd', persona: {}, tools: {}, ...over }
}

describe('office-experts · 基座 ⊕ delta 合成', () => {
  it('基座含核心行 + 高级默认关', () => {
    const ids = OFFICE_BASE.map((row) => row.id)
    for (const id of ['persona', 'tool-fs', 'tool-todo', 'tool-web', 'tool-skill', 'skill-filesystem', 'compaction']) {
      expect(ids).toContain(id)
    }
    for (const id of ADVANCED_ROW_IDS) {
      expect(OFFICE_BASE.find((row) => row.id === id)?.disabled).toBe(true)
    }
    // 不采用内核编码 agent 的 shell 工具
    expect(ids).not.toContain('tool-bash')
    expect(ids).not.toContain('tool-pwsh')
  })

  it('人设覆盖（且不动基座）', () => {
    const rows = composeExpertRows(delta({ persona: { prefix: '你是资深法务' } }))
    const persona = rows.find((row) => row.id === 'persona')
    expect((persona?.config as { prefix: string }).prefix).toBe('你是资深法务')
    expect((OFFICE_BASE.find((row) => row.id === 'persona')?.config as { prefix: string }).prefix).not.toBe('你是资深法务')
  })

  it('工具勾选：enable 开高级、disable 关核心', () => {
    const rows = composeExpertRows(delta({ tools: { enable: ['plan-mode'], disable: ['tool-web'] } }))
    expect(rows.find((row) => row.id === 'plan-mode')?.disabled).toBe(false)
    expect(rows.find((row) => row.id === 'tool-web')?.disabled).toBe(true)
  })

  it('未知行 id 的勾选被忽略（不抛）', () => {
    const rows = composeExpertRows(delta({ tools: { enable: ['nope'], disable: ['also-nope'] } }))
    expect(rows.length).toBe(OFFICE_BASE.length)
  })

  it('技能勾选写进 office-skills 行（C4b）', () => {
    const rows = composeExpertRows(delta({ skills: ['meeting-minutes', 'weekly-report'] }))
    const row = rows.find((item) => item.id === 'office-skills')
    expect((row?.config as { skills: string[] }).skills).toEqual(['meeting-minutes', 'weekly-report'])
    // 未给 skills ⇒ 不过滤
    const plain = composeExpertRows(delta())
    expect((plain.find((item) => item.id === 'office-skills')?.config as { skills?: string[] }).skills).toBeUndefined()
  })

  it('composeExpert 产出定义（id/name/plugins）', () => {
    const def = composeExpert(delta({ id: 'e1', name: 'E1', description: '专家' }))
    expect(def.id).toBe('e1')
    expect(def.name).toBe('E1')
    expect(def.plugins.length).toBe(OFFICE_BASE.length)
  })
})
