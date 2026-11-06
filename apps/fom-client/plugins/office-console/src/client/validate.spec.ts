import { describe, expect, it } from 'vitest'
import { hasErrors, validateExpertDraft, validateSkillDraft } from './validate.ts'

describe('office-console · 表单校验', () => {
  it('技能：必填三项（slug/name/body），description 可选', () => {
    const errors = validateSkillDraft({ slug: '', name: '', description: '', body: '' })
    expect(errors).toEqual({ slug: '必填', name: '必填', body: '必填' })
    expect(hasErrors(validateSkillDraft({ slug: 's', name: 'N', description: '', body: 'B' }))).toBe(false)
  })

  it('技能：slug 规则（小写字母数字开头，可含 . _ -）', () => {
    expect(validateSkillDraft({ slug: 'Bad', name: 'N', description: '', body: 'B' }).slug).toContain('开头')
    expect(validateSkillDraft({ slug: 'a_b.c-1', name: 'N', description: '', body: 'B' }).slug).toBeUndefined()
  })

  it('专家：必填 id/name；id 规则同一条', () => {
    expect(validateExpertDraft({ id: '', name: '', description: '', personaPrefix: '', planMode: false, subagent: false }))
      .toEqual({ id: '必填', name: '必填' })
    expect(validateExpertDraft({ id: 'e1', name: 'E', description: '', personaPrefix: '', planMode: true, subagent: false }).id).toBeUndefined()
    expect(validateExpertDraft({ id: 'BAD', name: 'E', description: '', personaPrefix: '', planMode: false, subagent: false }).id).toContain('开头')
  })
})
