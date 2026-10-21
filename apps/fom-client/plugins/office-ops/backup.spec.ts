import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_ENTRIES, DISPOSABLE_ENTRIES, backupHome, existingBackupEntries } from './backup.ts'

let home: string
let dest: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'office-ops-home-'))
  dest = mkdtempSync(join(tmpdir(), 'office-ops-dest-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(dest, { recursive: true, force: true })
})

describe('office-ops · 备份清单（对齐部署运维 O4）', () => {
  it('必备份清单含 sessions/storages/凭据/profiles 等；可丢清单含 cache/logs', () => {
    expect(BACKUP_ENTRIES).toContain('sessions')
    expect(BACKUP_ENTRIES).toContain('storages')
    expect(BACKUP_ENTRIES).toContain('.credentials.yaml')
    expect(BACKUP_ENTRIES).toContain('profiles')
    expect(DISPOSABLE_ENTRIES).toContain('cache')
    expect(DISPOSABLE_ENTRIES).toContain('logs')
  })

  it('existingBackupEntries 只列存在的条目（且不含可丢项）', () => {
    mkdirSync(join(home, 'sessions'))
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\n')
    mkdirSync(join(home, 'cache'))
    const entries = existingBackupEntries(home)
    expect(entries).toEqual(['sessions', '.credentials.yaml'])
    expect(entries).not.toContain('cache')
  })
})

describe('office-ops · 冷备', () => {
  it('backupHome 复制必备份条目，不带可丢项', () => {
    mkdirSync(join(home, 'sessions', 'x'), { recursive: true })
    writeFileSync(join(home, 'sessions', 'x', 'a.txt'), 'hi')
    writeFileSync(join(home, '.env'), 'A=1\n')
    mkdirSync(join(home, 'cache', 'attachments'), { recursive: true })

    const copied = backupHome(home, dest)
    expect(copied).toEqual(['sessions', '.env'])
    expect(existsSync(join(dest, 'sessions', 'x', 'a.txt'))).toBe(true)
    expect(existsSync(join(dest, '.env'))).toBe(true)
    expect(existsSync(join(dest, 'cache'))).toBe(false)
  })

  it('空 home 备份返回空清单', () => {
    expect(backupHome(home, dest)).toEqual([])
  })
})
