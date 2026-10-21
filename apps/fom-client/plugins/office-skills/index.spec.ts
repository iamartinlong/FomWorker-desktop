/**
 * `office-skills` 技能提供者的验收单测（不起 cordis，直接验 list/get 与两条守卫）。
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { SkillLookupOptions } from '@deepseek-ai/dsh-skill'
import { createOfficeSkillsProvider } from './index.ts'

const assetRoot = fileURLToPath(new URL('./assets/', import.meta.url))
const options: SkillLookupOptions = {} as SkillLookupOptions

/** `list()` 返回「候选数组 或 不完整观测」的联合；测试里只认前者。 */
async function listSkills(): Promise<readonly import('@deepseek-ai/dsh-skill').SkillCandidate[]> {
  const listed = await createOfficeSkillsProvider(assetRoot).list(options)
  if (!Array.isArray(listed)) throw new Error('provider returned an incomplete observation, not candidates')
  return listed
}

describe('office-skills provider', () => {
  it('list 返回两个技能并带描述', async () => {
    const candidates = await listSkills()
    expect(candidates.map(candidate => candidate.name)).toEqual(['meeting-minutes', 'weekly-report'])
    expect(candidates[0]?.description).toContain('会议纪要')
    expect(candidates[1]?.description).toContain('周报')
    expect(candidates[0]?.provider).toBe('dsh-office-platform')
  })

  it('get 返回正文：已剥 frontmatter，且含四段结构与工具名', async () => {
    const provider = createOfficeSkillsProvider(assetRoot)
    const candidates = await listSkills()
    const candidate = candidates[0]
    if (candidate === undefined) throw new Error('no candidate')
    const skill = await provider.get(candidate, options)
    expect(skill?.content).toContain('待办事项')
    expect(skill?.content).toContain('feishu_doc_create')
    expect(skill?.content.startsWith('---')).toBe(false)
  })

  it('weekly-report 正文含周报五段结构与多源取数工具', async () => {
    const provider = createOfficeSkillsProvider(assetRoot)
    const candidates = await listSkills()
    const candidate = candidates[1]
    if (candidate === undefined) throw new Error('no candidate')
    const skill = await provider.get(candidate, options)
    expect(skill?.content).toContain('本周概要')
    expect(skill?.content).toContain('feishu_bitable_list_records')
    expect(skill?.content).toContain('feishu_calendar_list_events')
    expect(skill?.content.startsWith('---')).toBe(false)
  })

  it('assetRoot 不是绝对路径 ⇒ 抛', () => {
    expect(() => createOfficeSkillsProvider('relative/assets')).toThrow(/绝对路径/)
  })

  it('SKILL.md 缺失 ⇒ 响亮抛（不静默装一个没有正文的技能）', () => {
    expect(() => createOfficeSkillsProvider('C:/no-such-office-skills-assets-xyz')).toThrow()
  })
})
