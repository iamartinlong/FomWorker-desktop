/**
 * `office-skills` 技能提供者的验收单测（不起 cordis，直接验 list/get 与两条守卫）。
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillLookupOptions } from '@deepseek-ai/dsh-skill'
import { createOfficeSkillsProvider, isSkillRootPath, watchSkillRoot } from './index.ts'

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

describe('isSkillRootPath（受管根路径判据）', () => {
  it('命中 <root>/<slug>/SKILL.md 与平铺 <root>/<slug>.md', () => {
    expect(isSkillRootPath('/root', '/root/demo/SKILL.md')).toBe(true)
    expect(isSkillRootPath('/root', '/root/demo.md')).toBe(true)
  })

  it('拒绝根本身、根外路径、深层路径与非技能文件', () => {
    expect(isSkillRootPath('/root', '/root')).toBe(false)
    expect(isSkillRootPath('/root', '/other/demo/SKILL.md')).toBe(false)
    expect(isSkillRootPath('/root', '/root/demo/references/ops.md')).toBe(false)
    expect(isSkillRootPath('/root', '/root/demo/notes.txt')).toBe(false)
  })
})

describe('watchSkillRoot（受管根监听）', () => {
  /** 轮询等条件成立；超时抛，避免测试挂死。 */
  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('watchSkillRoot: 等待回调超时')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('技能目录里的 SKILL.md 被写入后回调（防抖合并成一次）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-skills-watch-'))
    const skill = join(root, 'demo')
    mkdirSync(skill)
    let calls = 0
    const unwatch = watchSkillRoot(root, () => { calls += 1 })
    try {
      writeFileSync(join(skill, 'SKILL.md'), '---\nname: demo\n---\n')
      await waitFor(() => calls > 0)
    } finally {
      unwatch()
      rmSync(root, { recursive: true, force: true })
    }
    expect(calls).toBeGreaterThan(0)
  })

  it('注销后不再回调', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-skills-watch-'))
    const skill = join(root, 'demo')
    mkdirSync(skill)
    let calls = 0
    const unwatch = watchSkillRoot(root, () => { calls += 1 })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: demo\n---\n')
    await waitFor(() => calls > 0)
    const seen = calls
    unwatch()
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: demo2\n---\n')
    await new Promise((resolve) => setTimeout(resolve, 400))
    rmSync(root, { recursive: true, force: true })
    expect(calls).toBe(seen)
  })

  it('根目录原本不存在：出现后新增技能也能被捕获', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-skills-watch-'))
    const missing = join(root, 'office', 'skills')
    let calls = 0
    const unwatch = watchSkillRoot(missing, () => { calls += 1 })
    try {
      mkdirSync(missing)
      // 等 `watchFile` 轮询（500ms）发现根并改挂真监听，再往里放技能。
      await new Promise((resolve) => setTimeout(resolve, 800))
      mkdirSync(join(missing, 'demo'))
      writeFileSync(join(missing, 'demo', 'SKILL.md'), '---\nname: demo\n---\n')
      await waitFor(() => calls > 0, 5000)
    } finally {
      unwatch()
      rmSync(root, { recursive: true, force: true })
    }
    expect(calls).toBeGreaterThan(0)
  })
})
