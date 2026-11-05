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
})
