/**
 * 「一 home 一活实例」的**文件锁**（M2 · O-P1）：保证同一个 `$DSH_HOME` 同时只有一个活写者。
 *
 * 依据：`docs/02-设计/部署与运维形态设计v0.1.md` O6 —— `schedule.json`/storage 是**单写者 last-write-wins**、
 * 无跨进程锁，两实例共 home ⇒ 静默丢更新。内核**没有**这个锁（O9）⇒ 自建。
 *
 * 语义：
 * - 锁文件 `<home>/office-instance.lock`，内容＝持有者 pid。
 * - 用 `openSync(path,'wx')`（排他创建）抢占；已被占用则**检查持有者是否还活着**：
 *   - 活着 ⇒ 抛 `HomeLockError`（**响亮失败**，绝不静默覆盖）；
 *   - 已死（陈旧锁）⇒ 接管。
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** 锁文件名。 */
export const LOCK_FILENAME = 'office-instance.lock'

/** 抢锁失败（判别看 `code`，不看 `instanceof`）。 */
export class HomeLockError extends Error {
  readonly code = 'office-ops/home-locked'
  readonly holderPid?: number
  constructor(homeDir: string, holderPid?: number) {
    super(`home 已被占用：${homeDir}${holderPid === undefined ? '' : `（持有人 pid ${holderPid}）`}`)
    this.name = 'HomeLockError'
    if (holderPid !== undefined) this.holderPid = holderPid
  }
}

/** 一把已持有的锁。 */
export interface HomeLock {
  readonly path: string
  /** 释放锁（幂等）。 */
  release(): void
}

/** pid 是否活着（`EPERM` 视为活）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readHolderPid(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isFinite(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

function tryCreate(path: string): number | undefined {
  try {
    return openSync(path, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw error
  }
}

/**
 * 抢占一个 home 的活实例锁。
 * @param homeDir - `$DSH_HOME` 目录（须已存在）。
 * @param options - `pid` 覆盖写入的持有者 pid（默认当前进程；测试用）。
 * @returns 锁句柄；调用方负责 `release()`。
 * @throws {HomeLockError} 已被一个**活着的**进程持有时。
 */
export function acquireHomeLock(homeDir: string, options: { pid?: number } = {}): HomeLock {
  const path = join(homeDir, LOCK_FILENAME)
  const pid = options.pid ?? process.pid

  let fd = tryCreate(path)
  if (fd === undefined) {
    const holder = readHolderPid(path)
    if (holder !== undefined && !isProcessAlive(holder)) {
      // 陈旧锁：持有者已死，接管。
      try { unlinkSync(path) } catch { /* 竞态：别人已删 */ }
      fd = tryCreate(path)
    }
    if (fd === undefined) throw new HomeLockError(homeDir, holder)
  }

  writeSync(fd, String(pid))
  let released = false
  return {
    path,
    release: () => {
      if (released) return
      released = true
      try { closeSync(fd as number) } catch { /* 已关 */ }
      try { unlinkSync(path) } catch { /* 已删 */ }
    },
  }
}
