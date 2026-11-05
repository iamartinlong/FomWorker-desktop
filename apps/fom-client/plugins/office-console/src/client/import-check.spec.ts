import { describe, expect, it } from 'vitest'
import { EXPERT_KIND, PORTABLE_VERSION, SKILL_KIND, checkImportFile } from './import-check.ts'

describe('office-console · 导入浅检（客户端）', () => {
  it('技能包：合法 → 通过', () => {
    const r = checkImportFile('skill', JSON.stringify({ kind: SKILL_KIND, version: PORTABLE_VERSION, slug: 's', name: 'N', body: 'B' }))
    expect(r.ok).toBe(true)
    expect(r.name).toBe('s')
  })

  it('不是 JSON / 不是对象 → 拒', () => {
    expect(checkImportFile('skill', 'not-json').message).toContain('合法 JSON')
    expect(checkImportFile('skill', '[1,2]').message).toContain('JSON 对象')
  })

  it('kind / version 不符 → 点名', () => {
    expect(checkImportFile('skill', JSON.stringify({ kind: 'fom-expert' })).message).toContain(SKILL_KIND)
    expect(checkImportFile('skill', JSON.stringify({ kind: SKILL_KIND, version: 9 })).message).toContain(`version 应为 ${PORTABLE_VERSION}`)
  })

  it('技能缺字段 / 专家缺字段 → 拒', () => {
    expect(checkImportFile('skill', JSON.stringify({ kind: SKILL_KIND, version: PORTABLE_VERSION, slug: 's' })).message).toContain('slug / name / body')
    expect(checkImportFile('expert', JSON.stringify({ kind: EXPERT_KIND, version: PORTABLE_VERSION, id: 'e' })).message).toContain('id / name')
  })

  it('专家包：合法 → 通过', () => {
    const r = checkImportFile('expert', JSON.stringify({ kind: EXPERT_KIND, version: PORTABLE_VERSION, id: 'e1', name: 'E' }))
    expect(r.ok).toBe(true)
    expect(r.name).toBe('e1')
  })
})
