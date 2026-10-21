import { describe, expect, it } from 'vitest'
import {
  EXPERT_KIND,
  PORTABLE_VERSION,
  SKILL_KIND,
  exportExpert,
  exportSkill,
  parsePortableExpert,
  parsePortableSkill,
  portableKind,
} from './portable.ts'

describe('office-console · portable（C4e 可分享包）', () => {
  it('exportSkill → 包；parse 往返一致', () => {
    const pkg = exportSkill({ slug: 's', name: 'N', description: 'D', body: 'B' })
    expect(pkg).toEqual({ kind: SKILL_KIND, version: PORTABLE_VERSION, slug: 's', name: 'N', description: 'D', body: 'B' })
    expect(parsePortableSkill(pkg).skill).toEqual(pkg)
  })

  it('parsePortableSkill 响亮拒（kind / version / slug / name / body 逐项报）', () => {
    expect(parsePortableSkill({ kind: 'x' }).problems).toContain(`kind 须为 ${SKILL_KIND}（收到 "x"）`)
    expect(parsePortableSkill({ kind: SKILL_KIND, version: 99 }).problems.some((p) => p.includes('version 须为'))).toBe(true)
    const bad = parsePortableSkill({ kind: SKILL_KIND, version: PORTABLE_VERSION, slug: 'BAD', name: '', body: '' }).problems
    expect(bad.some((p) => p.includes('slug 非法'))).toBe(true)
    expect(bad).toContain('缺 name')
    expect(bad).toContain('缺 body')
  })

  it('parsePortableSkill 非对象 → 拒', () => {
    expect(parsePortableSkill('nope').problems).toEqual(['不是对象'])
  })

  it('exportExpert / parsePortableExpert 往返一致', () => {
    const pkg = exportExpert({ id: 'e1', name: 'E', description: 'D', persona: { prefix: 'p' }, tools: { enable: ['x'] }, skills: ['s'] })
    expect(pkg).toEqual({ kind: EXPERT_KIND, version: PORTABLE_VERSION, id: 'e1', name: 'E', description: 'D', persona: { prefix: 'p' }, tools: { enable: ['x'] }, skills: ['s'] })
    expect(parsePortableExpert(pkg).expert).toEqual(pkg)
  })

  it('parsePortableExpert 响亮拒（kind / id）', () => {
    expect(parsePortableExpert({ kind: 'x' }).problems.some((p) => p.includes('kind 须为'))).toBe(true)
    expect(parsePortableExpert({ kind: EXPERT_KIND, version: PORTABLE_VERSION, id: 'BAD' }).problems.some((p) => p.includes('id 非法'))).toBe(true)
  })

  it('portableKind 按 kind 判别', () => {
    expect(portableKind({ kind: SKILL_KIND })).toBe('skill')
    expect(portableKind({ kind: EXPERT_KIND })).toBe('expert')
    expect(portableKind({ kind: 'x' })).toBeUndefined()
    expect(portableKind(null)).toBeUndefined()
  })
})
