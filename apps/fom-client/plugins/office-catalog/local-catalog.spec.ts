import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLocalCatalog, readLocalCatalog, writeLocalCatalog } from './local-catalog.ts'
import type { CatalogEntry } from './catalog.ts'

/** 造一条最小条目。 */
function entry(origin: CatalogEntry['origin']): CatalogEntry {
  return {
    id: 'skill:x', kind: 'skill', name: 'X', description: 'd', version: '1.0.0', category: 'c',
    origin, defaultEnabled: false, source: { kind: 'bundle', ref: 'skill:x' }, tags: [],
  }
}

describe('office-catalog · 本地目录文件', () => {
  it('parse：强制 origin=local，坏条目跳过并记 problems', () => {
    const result = parseLocalCatalog({
      schemaVersion: 1,
      entries: [
        { id: 'skill:ok', kind: 'skill', name: 'OK' },
        { id: 'bad', kind: 'skill', name: 'bad' },
        { id: 'skill:nokind', kind: 'nope', name: 'x' },
      ],
    })
    expect(result.entries.map((item) => item.id)).toEqual(['skill:ok'])
    expect(result.entries[0]?.origin).toBe('local')
    expect(result.problems.length).toBe(2)
  })

  it('parse：非对象 / schemaVersion 不符', () => {
    expect(parseLocalCatalog(null).problems).toContain('本地目录不是对象')
    expect(parseLocalCatalog({ schemaVersion: 9, entries: [] }).problems.some((p) => p.includes('schemaVersion'))).toBe(true)
    expect(parseLocalCatalog({ schemaVersion: 1, entries: 'nope' }).problems.some((p) => p.includes('非数组'))).toBe(true)
  })

  it('read 不存在 → 空数组（不抛）', () => {
    expect(readLocalCatalog(join(tmpdir(), `nope-${Date.now()}.json`))).toEqual([])
  })

  it('write→read 往返：origin 一律落 local', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fom-local-cat-'))
    try {
      const path = join(dir, 'catalog.local.json')
      writeLocalCatalog(path, [entry('platform')])
      const back = readLocalCatalog(path)
      expect(back.map((item) => item.id)).toEqual(['skill:x'])
      expect(back[0]?.origin).toBe('local')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // T1（《详细实施-连接器配置表单v0.1》）：连接器的 spec 要能原样穿过本地目录文件。
  it('spec 原样穿过 parse/write→read（连接器配置表单的输入源）', () => {
    const spec = { transport: 'streamable-http', url: 'https://example.com/mcp', scopes: ['doc'] }
    const parsed = parseLocalCatalog({
      schemaVersion: 1,
      entries: [{ id: 'connector:demo', kind: 'connector', name: 'Demo', spec }],
    })
    expect(parsed.entries[0]?.spec).toEqual(spec)
    const dir = mkdtempSync(join(tmpdir(), 'fom-local-cat-'))
    try {
      const path = join(dir, 'catalog.local.json')
      writeLocalCatalog(path, parsed.entries)
      const back = readLocalCatalog(path)
      expect(back[0]?.spec).toEqual(spec)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 坏 spec 不能把整份目录拖垮，也不能把 null/数组/字符串塞进条目
  it('spec 非对象 ⇒ 不设该键（不抛、不拖垮其余条目）', () => {
    const result = parseLocalCatalog({
      schemaVersion: 1,
      entries: [
        { id: 'connector:a', kind: 'connector', name: 'A', spec: { transport: 'stdio', command: 'node' } },
        { id: 'connector:b', kind: 'connector', name: 'B', spec: null },
        { id: 'connector:c', kind: 'connector', name: 'C', spec: ['x'] },
        { id: 'connector:d', kind: 'connector', name: 'D', spec: 'stdio' },
        { id: 'skill:e', kind: 'skill', name: 'E' },
      ],
    })
    expect(result.entries.map((item) => item.id)).toEqual(['connector:a', 'connector:b', 'connector:c', 'connector:d', 'skill:e'])
    expect(result.problems).toEqual([])
    expect(result.entries[0]?.spec).toEqual({ transport: 'stdio', command: 'node' })
    expect('spec' in (result.entries[1] ?? {})).toBe(false)
    expect('spec' in (result.entries[2] ?? {})).toBe(false)
    expect('spec' in (result.entries[3] ?? {})).toBe(false)
    expect('spec' in (result.entries[4] ?? {})).toBe(false)
  })
})
