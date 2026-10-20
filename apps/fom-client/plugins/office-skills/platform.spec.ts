import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPLIED_FILE, materializePlatformSkills, readApplied, skillFromEntry, writeApplied } from './platform.ts'

describe('office-skills · C5 平台下发物化', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fom-plat-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('skillFromEntry：只认 kind=skill 且 spec.slug/body 齐（并带 version/contentHash）', () => {
    expect(skillFromEntry({ kind: 'skill', spec: { slug: 'a', body: 'B' } })).toEqual({ slug: 'a', name: 'a', description: '', body: 'B', version: '', contentHash: '' })
    expect(skillFromEntry({ kind: 'skill', version: '1.2.0', contentHash: 'h', spec: { slug: 'a', name: 'A', description: 'D', body: 'B' } })).toEqual({ slug: 'a', name: 'A', description: 'D', body: 'B', version: '1.2.0', contentHash: 'h' })
    expect(skillFromEntry({ kind: 'expert', spec: { slug: 'a', body: 'B' } })).toBeUndefined()
    expect(skillFromEntry({ kind: 'skill', spec: { slug: 'a' } })).toBeUndefined()
    expect(skillFromEntry({ kind: 'skill' })).toBeUndefined()
    expect(skillFromEntry(null)).toBeUndefined()
  })

  it('物化：写 SKILL.md、剪掉不在下发集的旧技能、跳过非技能、同 slug 去重', () => {
    materializePlatformSkills(root, [{ kind: 'skill', spec: { slug: 'old', body: 'x' } }])
    const result = materializePlatformSkills(root, [
      { kind: 'skill', version: '1.0.0', contentHash: 'h1', spec: { slug: 'a', name: 'A', description: 'D', body: '正文 A' } },
      { kind: 'expert', spec: { slug: 'e' } },
      { kind: 'skill', version: '1.0.0', contentHash: 'h1', spec: { slug: 'a', body: '重复' } },
    ])
    expect(result.written).toEqual(['a'])
    expect(result.removed).toEqual(['old'])
    expect(result.skipped).toBe(1)
    expect(existsSync(join(root, 'a', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'old'))).toBe(false)
  })

  it('⭐版本判定：`(version, contentHash)` 未变 ⇒ **跳过重写**；变了 ⇒ `updated`；撤下 ⇒ `removed`', () => {
    const entry = (version: string, contentHash: string, body: string): unknown => ({ kind: 'skill', version, contentHash, spec: { slug: 'a', name: 'A', body } })
    const first = materializePlatformSkills(root, [entry('1.0.0', 'h1', 'B1')])
    expect(first.written).toEqual(['a'])
    expect(first.unchanged).toEqual([])
    expect(first.applied).toEqual({ a: { version: '1.0.0', contentHash: 'h1' } })

    // 第二次同版本同指纹 ⇒ 跳过
    const second = materializePlatformSkills(root, [entry('1.0.0', 'h1', 'B1')], first.applied)
    expect(second.written).toEqual([])
    expect(second.updated).toEqual([])
    expect(second.unchanged).toEqual(['a'])

    // 版本+指纹变 ⇒ updated
    const third = materializePlatformSkills(root, [entry('1.1.0', 'h2', 'B2')], second.applied)
    expect(third.updated).toEqual(['a'])
    expect(third.unchanged).toEqual([])

    // 撤下 ⇒ removed
    const fourth = materializePlatformSkills(root, [], third.applied)
    expect(fourth.removed).toEqual(['a'])
    expect(fourth.applied).toEqual({})
  })

  it('readApplied/writeApplied 往返（坏 JSON → 空表）', () => {
    writeApplied(root, { a: { version: '1.0.0', contentHash: 'h1' } })
    expect(readApplied(root)).toEqual({ a: { version: '1.0.0', contentHash: 'h1' } })
    writeFileSync(join(root, APPLIED_FILE), 'not-json')
    expect(readApplied(root)).toEqual({})
  })

  it('非法 slug 响亮抛（不静默跳过）', () => {
    expect(() => materializePlatformSkills(root, [{ kind: 'skill', spec: { slug: 'BAD', body: 'x' } }])).toThrow(/非法技能 slug/u)
  })

  it('空下发集 ⇒ 全剪', () => {
    materializePlatformSkills(root, [{ kind: 'skill', spec: { slug: 'a', body: 'x' } }])
    const result = materializePlatformSkills(root, [])
    expect(result.written).toEqual([])
    expect(result.removed).toEqual(['a'])
  })
})
