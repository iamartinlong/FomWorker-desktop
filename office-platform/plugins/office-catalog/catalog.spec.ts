import { describe, expect, it } from 'vitest'
import {
  CATALOG_KINDS,
  CATALOG_VERSION,
  DEFAULT_CATALOG,
  createCatalogService,
  validateCatalog,
  type CatalogEntry,
} from './catalog.ts'

describe('L0 默认能力目录 · 数据', () => {
  it('内置目录通过校验', () => {
    expect(validateCatalog(DEFAULT_CATALOG)).toEqual([])
  })

  it('三大类都有默认项', () => {
    for (const kind of CATALOG_KINDS) {
      expect(DEFAULT_CATALOG.some((entry) => entry.kind === kind)).toBe(true)
    }
  })

  it('目录与条目被深冻结（消费方改不动默认）', () => {
    expect(Object.isFrozen(DEFAULT_CATALOG)).toBe(true)
    const entry = DEFAULT_CATALOG[0]
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry.source)).toBe(true)
    expect(Object.isFrozen(entry.tags)).toBe(true)
  })
})

describe('L0 默认能力目录 · 只读查询面', () => {
  const svc = createCatalogService()

  it('暴露目录 schema 版本', () => {
    expect(svc.version).toBe(CATALOG_VERSION)
  })

  it('list() 返回全部', () => {
    expect(svc.list().length).toBe(DEFAULT_CATALOG.length)
  })

  it('list(kind) 只返回该大类', () => {
    const skills = svc.list('skill')
    expect(skills.length).toBeGreaterThan(0)
    expect(skills.every((entry) => entry.kind === 'skill')).toBe(true)
  })

  it('list() 返回新数组，改不动内部', () => {
    const first = svc.list()
    first.pop()
    expect(svc.list().length).toBe(DEFAULT_CATALOG.length)
  })

  it('get() 命中与未命中', () => {
    expect(svc.get('skill:meeting-minutes')?.name).toBe('会议纪要分发')
    expect(svc.get('nope')).toBeUndefined()
  })

  it('validate() 与内置目录一致（无问题）', () => {
    expect(svc.validate()).toEqual([])
  })
})

describe('L0 默认能力目录 · 校验抓真缺陷', () => {
  const base: CatalogEntry = DEFAULT_CATALOG[0]
  const mk = (over: Partial<CatalogEntry>): CatalogEntry => ({ ...base, ...over })

  it('id 重复', () => {
    expect(validateCatalog([base, base])).toContainEqual(expect.stringContaining('id 重复'))
  })

  it('id 前缀与 kind 不符', () => {
    const problems = validateCatalog([mk({ id: 'skill:x', kind: 'connector' })])
    expect(problems).toContainEqual(expect.stringContaining('前缀与 kind 不符'))
  })

  it('缺字段逐个点名', () => {
    const problems = validateCatalog([
      mk({ id: 'skill:x', name: '', description: '', version: '', category: '' }),
    ])
    expect(problems).toContainEqual(expect.stringContaining('缺少 name'))
    expect(problems).toContainEqual(expect.stringContaining('缺少 description'))
    expect(problems).toContainEqual(expect.stringContaining('缺少 version'))
    expect(problems).toContainEqual(expect.stringContaining('缺少 category'))
  })

  it('缺 source.ref', () => {
    const problems = validateCatalog([mk({ id: 'skill:x', source: { kind: 'bundle', ref: '' } })])
    expect(problems).toContainEqual(expect.stringContaining('缺少 source.ref'))
  })
})
