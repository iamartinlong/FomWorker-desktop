import { describe, expect, it } from 'vitest'
import {
  CATALOG_KINDS,
  CATALOG_VERSION,
  DEFAULT_CATALOG,
  createCatalogService,
  mergeCatalog,
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

  it('内置默认目录全部标 origin=platform', () => {
    expect(DEFAULT_CATALOG.every((entry) => entry.origin === 'platform')).toBe(true)
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

  it('未知 origin 被点名', () => {
    const problems = validateCatalog([mk({ id: 'skill:x', origin: 'weird' as CatalogEntry['origin'] })])
    expect(problems).toContainEqual(expect.stringContaining('未知 origin'))
  })
})

describe('L0 默认能力目录 · 两源合并（G7）', () => {
  /** 造一条最小条目。 */
  const entry = (id: string, origin: CatalogEntry['origin']): CatalogEntry => ({
    id, kind: 'skill', name: id, description: 'd', version: '1.0.0', category: 'c',
    origin, defaultEnabled: true, source: { kind: 'bundle', ref: id }, tags: [],
  })

  it('同名本地覆盖平台、平台独有保留、本地新增追加', () => {
    const platform = [entry('skill:a', 'platform'), entry('skill:b', 'platform')]
    const local = [entry('skill:b', 'local'), entry('skill:c', 'local')]
    const merged = mergeCatalog(platform, local)
    expect(merged.map((item) => item.id)).toEqual(['skill:a', 'skill:b', 'skill:c'])
    expect(merged.find((item) => item.id === 'skill:b')?.origin).toBe('local')
    expect(merged.find((item) => item.id === 'skill:a')?.origin).toBe('platform')
  })

  it('createCatalogService 返回合并视图', () => {
    const svc = createCatalogService([entry('skill:a', 'platform')], [entry('skill:a', 'local')])
    expect(svc.list().length).toBe(1)
    expect(svc.get('skill:a')?.origin).toBe('local')
  })

  it('createCatalogService 支持「现读」本地源（函数）——新建后列表即时可见', () => {
    let local: CatalogEntry[] = []
    const svc = createCatalogService([entry('skill:a', 'platform')], () => local)
    expect(svc.list().map((item) => item.id)).toEqual(['skill:a'])
    local = [entry('skill:b', 'local')]
    expect(svc.list().map((item) => item.id)).toEqual(['skill:a', 'skill:b'])
  })
})
