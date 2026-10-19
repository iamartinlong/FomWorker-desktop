import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { consoleStateDir, readJsonFile, resolveDshHome, writeJsonFile } from './persist.ts'

describe('office-console · 本地持久化', () => {
  it('write→read 往返（自动建父目录）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fom-console-persist-'))
    try {
      const path = join(dir, 'nested', 'state.json')
      writeJsonFile(path, { a: 1, b: ['x'] })
      expect(readJsonFile<{ a: number; b: string[] }>(path)).toEqual({ a: 1, b: ['x'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('read 不存在 / 坏 JSON → undefined（不抛）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fom-console-persist-'))
    try {
      expect(readJsonFile(join(dir, 'nope.json'))).toBeUndefined()
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, '{ not json')
      expect(readJsonFile(bad)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveDshHome 优先环境变量；consoleStateDir 拼 office', () => {
    const previous = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = 'C:/tmp/fom-home'
      expect(resolveDshHome()).toBe('C:/tmp/fom-home')
      expect(consoleStateDir()).toBe(join('C:/tmp/fom-home', 'office'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('落盘内容是 pretty JSON + 尾换行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fom-console-persist-'))
    try {
      const path = join(dir, 'state.json')
      writeJsonFile(path, { a: 1 })
      expect(readFileSync(path, 'utf8')).toBe('{\n  "a": 1\n}\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
