import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SkillLookupOptions } from '@deepseek-ai/dsh-skill'
import { createManagedSkillsProvider } from './index.ts'
import {
  isValidSkillSlug,
  listManagedSkills,
  parseSkillFrontmatter,
  readManagedSkill,
  removeManagedSkill,
  renderSkillMarkdown,
  skillBody,
  writeManagedSkill,
} from './managed.ts'

const options = {} as SkillLookupOptions

describe('office-skills · 受管技能根', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fom-skills-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('slug 校验（拒大写 / 穿越 / 空）', () => {
    expect(isValidSkillSlug('my-skill')).toBe(true)
    expect(isValidSkillSlug('My-Skill')).toBe(false)
    expect(isValidSkillSlug('../evil')).toBe(false)
    expect(isValidSkillSlug('')).toBe(false)
  })

  it('render / parse frontmatter / body', () => {
    const markdown = renderSkillMarkdown({ slug: 'x', name: 'X 技能', description: '一句话', body: '正文内容' })
    expect(markdown.startsWith('---')).toBe(true)
    expect(parseSkillFrontmatter(markdown)).toEqual({ name: 'X 技能', description: '一句话' })
    expect(skillBody(markdown)).toBe('正文内容')
  })

  it('write→list→read→remove 往返', () => {
    writeManagedSkill(root, { slug: 'a-skill', name: 'A', description: 'd', body: 'b' })
    writeManagedSkill(root, { slug: 'b-skill', name: 'B', description: 'd', body: 'b' })
    expect(listManagedSkills(root)).toEqual(['a-skill', 'b-skill'])
    expect(readManagedSkill(root, 'a-skill')).toContain('name: A')
    expect(removeManagedSkill(root, 'a-skill')).toBe(true)
    expect(removeManagedSkill(root, 'a-skill')).toBe(false)
    expect(listManagedSkills(root)).toEqual(['b-skill'])
  })

  it('write 非法 slug 抛', () => {
    expect(() => writeManagedSkill(root, { slug: '../x', name: 'x', description: '', body: '' })).toThrow(/非法技能 slug/)
  })

  it('provider：list 现扫、get 剥 frontmatter；空目录为空', async () => {
    const provider = createManagedSkillsProvider(root)
    expect(await provider.list(options)).toEqual([])
    writeManagedSkill(root, { slug: 'my-skill', name: '我的技能', description: 'desc', body: '正文 body' })
    const listed = await provider.list(options)
    if (!Array.isArray(listed)) throw new Error('provider returned an incomplete observation')
    expect(listed.map((candidate) => candidate.name)).toEqual(['my-skill'])
    expect(listed[0]?.source).toBe('custom')
    expect(listed[0]?.description).toBe('desc')
    const skill = await provider.get(listed[0]!, options)
    expect(skill?.content).toBe('正文 body')
  })

  it('provider：managedRoot 非绝对路径 ⇒ 抛', () => {
    expect(() => createManagedSkillsProvider('relative')).toThrow(/绝对路径/)
  })
})
