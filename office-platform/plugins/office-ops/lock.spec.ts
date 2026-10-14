import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomeLockError, LOCK_FILENAME, acquireHomeLock, isProcessAlive } from './lock.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'office-ops-lock-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('office-ops · 一 home 一活实例锁', () => {
  it('首次抢锁成功，锁文件含当前 pid', () => {
    const lock = acquireHomeLock(home)
    expect(existsSync(join(home, LOCK_FILENAME))).toBe(true)
    lock.release()
    expect(existsSync(join(home, LOCK_FILENAME))).toBe(false)
  })

  it('被活进程持有时，第二次抢锁响亮失败', () => {
    const first = acquireHomeLock(home)
    const err = (() => { try { acquireHomeLock(home); return undefined } catch (e) { return e } })()
    expect(err).toBeInstanceOf(HomeLockError)
    expect((err as HomeLockError).code).toBe('office-ops/home-locked')
    expect((err as HomeLockError).holderPid).toBe(process.pid)
    first.release()
    // 释放后可再抢
    acquireHomeLock(home).release()
  })

  it('陈旧锁（持有者已死）被接管', () => {
    writeFileSync(join(home, LOCK_FILENAME), '999999') // 几乎不可能存在的 pid
    const lock = acquireHomeLock(home)
    expect(existsSync(join(home, LOCK_FILENAME))).toBe(true)
    lock.release()
  })

  it('release 幂等', () => {
    const lock = acquireHomeLock(home)
    lock.release()
    expect(() => lock.release()).not.toThrow()
  })

  it('isProcessAlive：当前进程 true，非法 pid false', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(999999)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })
})
