import { describe, expect, it } from 'vitest'
import { type CatalogEntry, categoriesOf, filterEntries, groupByKind } from './catalog-view.ts'

const entry = (id: string, kind: string, category?: string): CatalogEntry => ({ id, kind, name: id, ...(category === undefined ? {} : { category }) })

const ENTRIES: CatalogEntry[] = [
  entry('skill:a', 'skill', '办公协作'),
  entry('skill:b', 'skill', '文档'),
  entry('skill:c', 'skill', '办公协作'),
  entry('expert:x', 'expert'),
  entry('connector:y', 'connector', '接入'),
]

describe('groupByKind', () => {
  it('按 kind 分组且保序', () => {
    const g = groupByKind(ENTRIES)
    expect(Object.keys(g).sort()).toEqual(['connector', 'expert', 'skill'])
    expect(g.skill?.map((e) => e.id)).toEqual(['skill:a', 'skill:b', 'skill:c'])
    expect(g.expert).toHaveLength(1)
  })

  it('空输入', () => {
    expect(groupByKind([])).toEqual({})
  })
})

describe('categoriesOf', () => {
  it('去重、保序、剔空', () => {
    expect(categoriesOf(ENTRIES.filter((e) => e.kind === 'skill'))).toEqual(['办公协作', '文档'])
  })

  it('全空返回 []', () => {
    expect(categoriesOf([entry('skill:z', 'skill')])).toEqual([])
  })
})

describe('filterEntries', () => {
  const skills = ENTRIES.filter((e) => e.kind === 'skill')

  it('市场：全返回', () => {
    expect(filterEntries(skills, 'market', null, {})).toHaveLength(3)
  })

  it('已安装：按 enabled 过滤', () => {
    expect(filterEntries(skills, 'installed', null, { 'skill:a': true, 'skill:c': true }).map((e) => e.id)).toEqual(['skill:a', 'skill:c'])
  })

  it('分类筛选', () => {
    expect(filterEntries(skills, 'market', '办公协作', {}).map((e) => e.id)).toEqual(['skill:a', 'skill:c'])
  })

  it('已安装 + 分类叠加', () => {
    expect(filterEntries(skills, 'installed', '文档', { 'skill:b': true, 'skill:a': true }).map((e) => e.id)).toEqual(['skill:b'])
  })

  it('返回新数组（不改输入）', () => {
    const out = filterEntries(skills, 'market', null, {})
    expect(out).not.toBe(skills)
    expect(skills).toHaveLength(3)
  })
})
